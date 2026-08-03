import {
  buildAssignmentShortcode,
  renderQaPresentation,
  selectNextAssignments,
  TcpAssignment,
  TcpCompany,
  TcpTask,
} from '@tcp/shared';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import { Repository } from 'typeorm';
import { AgentOrchestrationService } from './agent-orchestration.service';
import { PauseAndResumeService } from './pause-and-resume.service';
import { QaVerdictService } from './qa-verdict.service';
import { TaskDeliverablesService } from './task-deliverables.service';
import { TaskDispatcher } from './task-dispatcher.service';
import { TaskFailureService } from './task-failure.service';
import { TaskStateService } from './task-state.service';

/**
 * Restates a task's expected outputs for the finalise agent, so it knows what
 * the deliverables must meet or exceed.
 */
function buildFinalisePrompt(task: TcpTask): string {
  const expectedLines = task.expected
    .map((e) =>
      e.type === 'task-completed-path'
        ? `- file: ${e.value}`
        : `- text: ${e.value || '(any text)'}`,
    )
    .join('\n');
  return `Task: ${task.request}\n\nThe task's expected outputs — make the completed deliverables meet or exceed these:\n${expectedLines}`;
}

/**
 * The real {@link TaskDispatcher}: drives a task forward through its lifecycle
 * — planner → implement assignments → QA → finalisation — dispatching an agent
 * for each step and deciding what happens once that step lands.
 *
 * Every handler re-reads current state and advances it with atomic conditional
 * UPDATEs (via {@link TaskStateService}), so it is idempotent under
 * duplicate/concurrent calls: only the caller that actually flips a status
 * proceeds to its side effects. The paths that end a task badly live in
 * {@link TaskFailureService}, QA verdicts in {@link QaVerdictService}, and
 * post-restart repair in {@link TaskRecoveryService}.
 */
@Injectable()
export class TaskOrchestrationService extends TaskDispatcher {
  private readonly logger = new Logger(TaskOrchestrationService.name);

  constructor(
    @InjectRepository(TcpTask)
    private readonly taskRepo: Repository<TcpTask>,
    @InjectRepository(TcpAssignment)
    private readonly assignmentRepo: Repository<TcpAssignment>,
    @InjectRepository(TcpCompany)
    private readonly companyRepo: Repository<TcpCompany>,
    private readonly agents: AgentOrchestrationService,
    private readonly pauseResume: PauseAndResumeService,
    private readonly qa: QaVerdictService,
    private readonly failures: TaskFailureService,
    private readonly deliverables: TaskDeliverablesService,
    private readonly state: TaskStateService,
  ) {
    super();
  }

  // Lifecycle hooks (TaskDispatcher)

  /**
   * Dispatches the planner for a freshly-started task: creates a plan-mode
   * assignment carrying the task's request and materials, then a plan agent for
   * it. Idempotent — no-op if a plan assignment already exists.
   */
  async dispatchPlanner(task: TcpTask): Promise<void> {
    const existing = await this.assignmentRepo.findOneBy({
      taskId: task.id,
      mode: 'plan',
    });
    if (existing) return;

    // TaskService.start already claimed ready → planning atomically before
    // calling here; this is the one place that reaction is recorded/emitted
    // (guarded by the same idempotency check as the rest of this method).
    await this.state.recordTaskState(task, 'planning', 'task started');

    const plannerRoleId = await this.resolvePlannerRole(task);
    if (!plannerRoleId) {
      // The start endpoint 422s when neither is set; reaching here means the
      // task was mutated between start and dispatch. Fail loudly, not silently.
      throw new Error(`Task ${task.id} has no resolvable planner role`);
    }

    const assignment = await this.assignmentRepo.save(
      this.assignmentRepo.create({
        taskId: task.id,
        companyId: task.companyId,
        mode: 'plan',
        shortcode: buildAssignmentShortcode(task.shortcode, 'plan', 0),
        prompt: task.request,
        roleId: plannerRoleId,
        status: 'in-progress',
        materials: task.materials,
        expected: [],
      }),
    );
    await this.state.recordAssignmentState(
      assignment,
      'assignment dispatched (plan)',
    );

    const agentId = await this.dispatchAgentFor(
      assignment,
      task.request,
      'create_plan',
    );
    this.logger.log(`Dispatched planner agent ${agentId} for task ${task.id}`);
  }

  /** Dispatches the first ready assignment once a plan exists. */
  async taskPlanned(task: TcpTask): Promise<void> {
    await this.advance(task.id);
  }

  /**
   * Creates and dispatches a QA agent for an assignment that has just been
   * handed to QA (status `in-qa`, its implementing agent paused). Idempotent —
   * no-op if a live QA assignment already targets it.
   */
  async assignmentReadyForQa(assignment: TcpAssignment): Promise<void> {
    const live = await this.assignmentRepo.findOneBy({
      targetAssignmentId: assignment.id,
      mode: 'qa',
      status: 'in-progress',
    });
    if (live) return;

    const qa = await this.assignmentRepo.save(
      this.assignmentRepo.create({
        taskId: assignment.taskId,
        companyId: assignment.companyId,
        mode: 'qa',
        shortcode: await this.qa.qaShortcode(assignment),
        targetAssignmentId: assignment.id,
        roleId: assignment.roleId,
        status: 'in-progress',
        prompt: renderQaPresentation(assignment),
        materials: assignment.materials,
        expected: [],
      }),
    );
    await this.state.recordAssignmentState(qa, 'assignment dispatched (qa)');

    const agentId = await this.dispatchAgentFor(
      qa,
      qa.prompt,
      'assure_assignment',
    );
    this.logger.log(
      `Dispatched QA agent ${agentId} for assignment ${assignment.id}`,
    );
  }

  /** Reacts to a QA verdict already recorded on the target assignment. */
  async assignmentAssured(assignment: TcpAssignment): Promise<void> {
    const target = await this.assignmentRepo.findOneBy({ id: assignment.id });
    if (!target || target.status !== 'in-qa') return;

    if (target.qaStatus === 'accepted') {
      // Only advance when the verdict actually landed — a duplicate assure
      // loses the claim and must not re-drive the task.
      if (await this.qa.accept(target)) await this.advance(target.taskId!);
    } else if (target.qaStatus === 'rejected') {
      await this.qa.reject(target);
    }
  }

  /**
   * Reaction to a finalise agent completing (its assignment already claimed
   * `succeeded`): record the task's final `completed` set from the completed/
   * directory, mark the task `succeeded`, and complete the finalise agent.
   */
  async assignmentFinalised(finalise: TcpAssignment): Promise<void> {
    if (!finalise.taskId) return;
    const task = await this.taskRepo.findOneBy({ id: finalise.taskId });
    if (!task) return;
    const completed = await this.deliverables.buildTaskCompleted(task);
    await this.taskRepo.update(task.id, { completed, status: 'succeeded' });
    await this.state.recordTaskState(
      task,
      'succeeded',
      'task finalised (expectations met)',
    );
    if (finalise.agentId) {
      await this.pauseResume.completeAgent(
        finalise.agentId,
        finalise.summary ?? '',
      );
    }
    this.logger.log(`Task ${task.id} finalised (succeeded)`);
  }

  /** Cascades a cancellation to the task's live assignments and their agents. */
  async cancelTask(task: TcpTask): Promise<void> {
    await this.failures.cancelTask(task);
  }

  // Advancement / finalisation

  /**
   * Dispatches the next ready assignment(s); when the plan is complete either
   * dispatches a finalise agent (task has expected outputs) or finalises
   * mechanically (no expected outputs). Also the entry point
   * {@link TaskRecoveryService} uses to restart a stalled task.
   */
  async advance(taskId: UUID): Promise<void> {
    const plan = await this.state.planAssignments(taskId);
    const next = selectNextAssignments(plan);
    if (next.length > 0) {
      for (const assignment of next) await this.dispatchAssignment(assignment);
      return;
    }

    const task = await this.taskRepo.findOneBy({ id: taskId });
    if (!task) return;
    const planComplete =
      plan.length > 0 && plan.every((a) => a.status === 'succeeded');
    if (!planComplete) return;

    if ((task.expected?.length ?? 0) > 0) {
      await this.dispatchFinalise(task);
    } else {
      await this.finaliseMechanical(task);
    }
  }

  /**
   * Merges inherited materials into an assignment, atomically claims it
   * `ready → in-progress`, and dispatches its implement agent. No-op if the
   * claim is lost (another dispatch/recovery won).
   */
  private async dispatchAssignment(assignment: TcpAssignment): Promise<void> {
    const materials = await this.deliverables.mergeMaterials(assignment);
    assignment.materials = materials;
    await this.assignmentRepo.update(assignment.id, {
      materials,
      qaStatus: null,
      qaFeedback: null,
    });

    const claimed = await this.state.transitionAssignment(
      assignment,
      'ready',
      'in-progress',
      'assignment dispatched (implement)',
    );
    if (!claimed) return;

    await this.state.recomputeTaskStatus(assignment.taskId!);

    const agentId = await this.dispatchAgentFor(
      assignment,
      assignment.prompt,
      'complete_assignment',
    );
    this.logger.log(
      `Dispatched implement agent ${agentId} for assignment ${assignment.id}`,
    );
  }

  /**
   * Finalises a task with no stated `expected` outputs: promote the assignment
   * deliverables, record `completed`, mark `succeeded`. Idempotent — no-op once
   * `completed` is set.
   */
  private async finaliseMechanical(task: TcpTask): Promise<void> {
    if (task.completed != null) return;
    await this.deliverables.promoteToTaskCompleted(task);
    const completed = await this.deliverables.buildTaskCompleted(task);
    await this.taskRepo.update(task.id, { completed, status: 'succeeded' });
    await this.state.recordTaskState(task, 'succeeded', 'task finalised');
    this.logger.log(`Task ${task.id} finalised (succeeded)`);
  }

  /**
   * Dispatches a finalise agent to bring the task's deliverables up to its
   * expected outputs. Promotes the assignment files first (so they exist even
   * if finalise fails — "fail but still promote"), holds the task in
   * `finalising`, and creates + dispatches a finalise-mode assignment.
   * Idempotent — no-op if a finalise assignment already exists.
   */
  private async dispatchFinalise(task: TcpTask): Promise<void> {
    const existing = await this.assignmentRepo.findOneBy({
      taskId: task.id,
      mode: 'finalise',
    });
    if (existing) return;

    await this.deliverables.promoteToTaskCompleted(task);
    await this.taskRepo.update(task.id, { status: 'finalising' });
    await this.state.recordTaskState(
      task,
      'finalising',
      'dispatching finalise agent',
    );

    const roleId = await this.resolvePlannerRole(task);
    if (!roleId) {
      throw new Error(`Task ${task.id} has no resolvable role for finalise`);
    }

    const prompt = buildFinalisePrompt(task);
    // One past the last implement step — finalise runs after the whole plan.
    const planIndex = (await this.state.planAssignments(task.id)).length + 1;
    const finalise = await this.assignmentRepo.save(
      this.assignmentRepo.create({
        taskId: task.id,
        companyId: task.companyId,
        mode: 'finalise',
        shortcode: buildAssignmentShortcode(
          task.shortcode,
          'finalise',
          planIndex,
        ),
        prompt,
        roleId,
        status: 'in-progress',
        materials: [],
        expected: [],
      }),
    );
    await this.state.recordAssignmentState(
      finalise,
      'assignment dispatched (finalise)',
    );

    const agentId = await this.dispatchAgentFor(
      finalise,
      prompt,
      'complete_assignment',
    );
    this.logger.log(`Dispatched finalise agent ${agentId} for task ${task.id}`);
  }

  // Helpers

  /**
   * Creates an agent for an assignment, back-links `assignment.agentId`, and
   * enqueues its start job. The back-link is done here (not in
   * `DbService.createAgent`, which only links auto-created orphan assignments)
   * so the assignment knows which agent is working it — the completion,
   * accept/reject, and QA paths all resolve the working agent through it.
   */
  private async dispatchAgentFor(
    assignment: TcpAssignment,
    initialPrompt: string,
    requiredTool: string,
  ): Promise<UUID> {
    const agent = await this.agents.createAgent({
      companyId: assignment.companyId,
      roleId: assignment.roleId,
      initialPrompt,
      assignmentId: assignment.id,
      requiredToolCalls: [requiredTool],
    });
    await this.assignmentRepo.update(assignment.id, { agentId: agent.id });
    await this.agents.dispatchStartJob(agent.id);
    return agent.id;
  }

  /** The role that plans and finalises a task: the task's own, else the company's. */
  private async resolvePlannerRole(task: TcpTask): Promise<UUID | null> {
    const company = await this.companyRepo.findOneByOrFail({
      id: task.companyId,
    });
    return task.plannerRoleId ?? company.plannerRoleId ?? null;
  }
}
