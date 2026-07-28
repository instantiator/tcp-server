import {
  AgentStatus,
  TcpAgent,
  TcpAssignment,
  TcpAssignmentStatus,
  TcpTask,
} from '@tcp/shared';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import { Repository } from 'typeorm';
import { claimStatus } from './claim-status';
import { TaskDeliverablesService } from './task-deliverables.service';
import { TaskStateService } from './task-state.service';

/**
 * Everything that ends a task badly: propagating an agent-run failure to the
 * assignment and task it belonged to, catching a planner that finished without
 * a plan, and cascading a cancellation down to live assignments and agents.
 *
 * Each path is idempotent per transition — the atomic claims in
 * {@link TaskStateService} mean a duplicate or concurrent call only ever
 * touches rows still in the state it expected.
 */
@Injectable()
export class TaskFailureService {
  constructor(
    @InjectRepository(TcpTask)
    private readonly taskRepo: Repository<TcpTask>,
    @InjectRepository(TcpAssignment)
    private readonly assignmentRepo: Repository<TcpAssignment>,
    @InjectRepository(TcpAgent)
    private readonly agentRepo: Repository<TcpAgent>,
    private readonly deliverables: TaskDeliverablesService,
    private readonly state: TaskStateService,
  ) {}

  /**
   * Propagates an agent-run failure to its task, when the failed agent's
   * assignment is task-linked. The reaction differs by assignment mode.
   */
  async handleAgentFailed(agentId: UUID, reason: string): Promise<void> {
    const assignment = await this.assignmentForAgent(agentId);
    if (!assignment?.taskId) return;

    switch (assignment.mode) {
      case 'plan':
        return this.failPlanner(assignment, reason);
      case 'finalise':
        return this.failFinalise(assignment, reason);
      case 'implement':
        return this.failImplement(assignment, reason);
      case 'qa':
        return this.failQa(assignment, reason);
    }
  }

  /**
   * Belt-and-braces runtime check for a planner that reached `Completed`
   * WITHOUT producing a plan. Called from the internal agent-completion
   * endpoint. This is normally impossible — `plan` mode has no pause vector
   * (the plan-mode tool filter drops consultation and user queries) and the
   * `create_plan` required-tool enforcement fails such a run instead — but if
   * it ever happens, fail the task now rather than leaving it wedged in
   * `planning` until restart reconciliation (same predicate). Idempotent via
   * {@link TaskStateService.failTask}; a no-op for every non-planner completion.
   */
  async handleAgentCompleted(agentId: UUID): Promise<void> {
    const assignment = await this.assignmentForAgent(agentId);
    if (assignment?.mode !== 'plan' || !assignment.taskId) return;

    const task = await this.taskRepo.findOneBy({ id: assignment.taskId });
    if (task?.status !== 'planning') return;

    const plan = await this.state.planAssignments(assignment.taskId);
    if (plan.length > 0) return;

    // Producing a plan is the required outcome of plan mode, so a plan-less
    // completion is a failed assignment — fail it alongside the task, not
    // just the task. Forced (not a status-gated claim) because create_plan
    // may have already marked it `succeeded` for an empty plan; either way
    // it must read `failed`. Idempotent via the `planning` guard above.
    const failureReason = 'created a plan with 0 assignments';
    await this.assignmentRepo.update(assignment.id, {
      status: 'failed',
      failureReason,
    });
    assignment.status = 'failed';
    assignment.failureReason = failureReason;
    await this.state.recordAssignmentState(
      assignment,
      'assignment failed (planner produced no plan)',
    );
    await this.state.failTask(
      assignment.taskId,
      'planner completed without producing a plan',
    );
  }

  /**
   * Cascades a task cancellation (the task itself was already atomically
   * moved to `cancelled` by {@link TaskService.cancel}) to its still-live
   * assignments, then to their working agents — in that order, so an
   * observer reading state mid-cascade never sees an agent stop before its
   * assignment (or an assignment stop before the task) reflects it.
   *
   * Idempotent per assignment/agent: each uses its own atomic conditional
   * UPDATE, so re-running (e.g. a duplicate call) only touches rows still in
   * a non-terminal state.
   */
  async cancelTask(task: TcpTask): Promise<void> {
    const assignments = await this.assignmentRepo.find({
      where: { taskId: task.id },
    });
    const terminalAssignment: TcpAssignmentStatus[] = [
      'succeeded',
      'failed',
      'cancelled',
    ];
    for (const assignment of assignments) {
      if (terminalAssignment.includes(assignment.status)) continue;
      const claimed = await claimStatus(
        this.assignmentRepo,
        assignment.id,
        assignment.status,
        'cancelled',
      );
      if (claimed === 0) continue;
      assignment.status = 'cancelled';
      await this.state.recordAssignmentState(assignment, 'task cancelled');

      if (assignment.agentId) await this.cancelAgent(assignment.agentId);
    }
    await this.state.recordTaskState(task, 'cancelled', 'task cancelled');
  }

  /** A failed planner fails its assignment and the task it was planning. */
  private async failPlanner(
    assignment: TcpAssignment,
    reason: string,
  ): Promise<void> {
    if (!(await this.claimAgentFailure(assignment, reason))) return;
    await this.state.failTask(assignment.taskId!, `planner failed: ${reason}`);
  }

  /**
   * A failed finalise agent fails the task, but the files it already promoted
   * stay — record `completed` from the completed/ directory before failing.
   */
  private async failFinalise(
    assignment: TcpAssignment,
    reason: string,
  ): Promise<void> {
    if (!(await this.claimAgentFailure(assignment, reason))) return;
    const task = await this.taskRepo.findOneBy({ id: assignment.taskId! });
    if (task) {
      const completed = await this.deliverables.buildTaskCompleted(task);
      await this.taskRepo.update(task.id, { completed });
    }
    await this.state.failTask(assignment.taskId!, `finalise failed: ${reason}`);
  }

  /** A failed implement agent fails its assignment and the task. */
  private async failImplement(
    assignment: TcpAssignment,
    reason: string,
  ): Promise<void> {
    if (!(await this.claimAgentFailure(assignment, reason))) return;
    await this.state.failTask(
      assignment.taskId!,
      `assignment ${assignment.id} failed: ${reason}`,
    );
  }

  /**
   * A failed QA agent fails the assignment it was reviewing, its own qa
   * assignment, and the task. The target's `in-qa → failed` claim is the gate:
   * if the target is no longer in-qa (a concurrent QA accept won the race),
   * this is a no-op — nothing is failed, matching that the reviewed assignment
   * already passed.
   */
  // ponytail: no QA-retry — a failed QA agent fails the task; re-dispatching
  // QA once is the upgrade path if this proves noisy.
  private async failQa(
    assignment: TcpAssignment,
    reason: string,
  ): Promise<void> {
    if (!assignment.targetAssignmentId) return;
    const claimed = await claimStatus(
      this.assignmentRepo,
      assignment.targetAssignmentId,
      'in-qa',
      'failed',
      {
        failureReason: `QA agent failed before completing review: ${reason}`,
      },
    );
    if (claimed === 0) return;
    await this.claimAgentFailure(assignment, reason);
    await this.state.failTask(
      assignment.taskId!,
      `QA agent failed for assignment ${assignment.targetAssignmentId}`,
    );
  }

  /** Claims an in-flight assignment `in-progress → failed` for a dead agent. */
  private claimAgentFailure(
    assignment: TcpAssignment,
    reason: string,
  ): Promise<boolean> {
    return this.state.transitionAssignment(
      assignment,
      'in-progress',
      'failed',
      'assignment failed (agent failed)',
      reason,
    );
  }

  /** Moves a still-live agent to `Cancelled`; a no-op once it is terminal. */
  private async cancelAgent(agentId: UUID): Promise<void> {
    await this.agentRepo
      .createQueryBuilder()
      .update(TcpAgent)
      .set({ status: AgentStatus.Cancelled })
      .where('id = :id', { id: agentId })
      .andWhere('status NOT IN (:...terminal)', {
        terminal: [
          AgentStatus.Completed,
          AgentStatus.Failed,
          AgentStatus.Cancelled,
        ],
      })
      .execute();
  }

  /** The assignment an agent is working, or null if it has none. */
  private async assignmentForAgent(
    agentId: UUID,
  ): Promise<TcpAssignment | null> {
    const agent = await this.agentRepo.findOneBy({ id: agentId });
    if (!agent?.assignmentId) return null;
    return this.assignmentRepo.findOneBy({ id: agent.assignmentId });
  }
}
