import { AgentStatus, TcpAgent, TcpAssignment, TcpTask } from '@tcp/shared';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TaskDeliverablesService } from './task-deliverables.service';
import { TaskFailureService } from './task-failure.service';
import { TaskOrchestrationService } from './task-orchestration.service';
import { TaskStateService } from './task-state.service';

/** Agent statuses a recovery pass treats as "no longer live". */
const DEAD_AGENT_STATES: AgentStatus[] = [
  AgentStatus.Completed,
  AgentStatus.Failed,
];

/**
 * Startup repair for tasks left mid-flight by a restart. Runs once on boot and
 * only touches work no live agent will finish: agents still `Running`/`Paused`
 * are left alone, because BullMQ and pause/resume own their recovery.
 */
@Injectable()
export class TaskRecoveryService implements OnModuleInit {
  private readonly logger = new Logger(TaskRecoveryService.name);

  constructor(
    @InjectRepository(TcpTask)
    private readonly taskRepo: Repository<TcpTask>,
    @InjectRepository(TcpAssignment)
    private readonly assignmentRepo: Repository<TcpAssignment>,
    @InjectRepository(TcpAgent)
    private readonly agentRepo: Repository<TcpAgent>,
    private readonly orchestration: TaskOrchestrationService,
    private readonly failures: TaskFailureService,
    private readonly deliverables: TaskDeliverablesService,
    private readonly state: TaskStateService,
  ) {}

  /** Reconciles every non-terminal task on startup (see {@link reconcileTask}). */
  async onModuleInit(): Promise<void> {
    const tasks = await this.taskRepo.find({
      where: [{ status: 'planning' }, { status: 'in-progress' }],
    });
    for (const task of tasks) {
      try {
        await this.reconcileTask(task);
      } catch (err) {
        this.logger.error(
          `reconcileTask(${task.id}) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** Idempotent reconciliation of a single non-terminal task after a restart. */
  async reconcileTask(task: TcpTask): Promise<void> {
    if (task.status === 'planning') return this.reconcilePlanning(task);
    if (task.status === 'finalising') return this.reconcileFinalising(task);
    if (task.status === 'in-progress') return this.reconcileInProgress(task);
  }

  /**
   * A planning task is only recoverable if its planner is still alive. A dead
   * planner — or one that completed without producing a plan — fails both the
   * plan assignment and the task, rather than leaving the task wedged.
   */
  private async reconcilePlanning(task: TcpTask): Promise<void> {
    const planner = await this.assignmentRepo.findOneBy({
      taskId: task.id,
      mode: 'plan',
    });
    const agent = planner?.agentId
      ? await this.agentRepo.findOneBy({ id: planner.agentId })
      : null;
    const plan = await this.state.planAssignments(task.id);
    const plannerDead =
      !agent ||
      agent.status === AgentStatus.Failed ||
      (agent.status === AgentStatus.Completed && plan.length === 0);
    if (!plannerDead) return;

    // Fail the plan assignment too (no-op if it isn't in-progress, e.g. a
    // planner that completed without a plan), so it isn't left stuck
    // `in-progress` while its task reads `failed`.
    if (planner) {
      await this.state.transitionAssignment(
        planner,
        'in-progress',
        'failed',
        'assignment failed (agent died before restart)',
        'agent died before restart',
      );
    }
    await this.state.failTask(task.id, 'planner did not produce a plan');
  }

  /**
   * A finalise agent that died mid-run fails the task — its files were already
   * promoted, so `completed` is recorded before failing. A live one is left to
   * BullMQ/pause-resume.
   */
  private async reconcileFinalising(task: TcpTask): Promise<void> {
    const finalise = await this.assignmentRepo.findOneBy({
      taskId: task.id,
      mode: 'finalise',
    });
    const agent = finalise?.agentId
      ? await this.agentRepo.findOneBy({ id: finalise.agentId })
      : null;
    if (!finalise || (agent && !DEAD_AGENT_STATES.includes(agent.status))) {
      return;
    }
    // Fail the finalise assignment too — otherwise it's left stuck
    // `in-progress` while its task reads `failed` (same as the live
    // handleAgentFailed path).
    await this.state.transitionAssignment(
      finalise,
      'in-progress',
      'failed',
      'assignment failed (agent died before restart)',
      'agent died before restart',
    );
    const completed = await this.deliverables.buildTaskCompleted(task);
    await this.taskRepo.update(task.id, { completed });
    await this.state.failTask(task.id, 'finalise agent died before restart');
  }

  /**
   * An in-progress task is repaired at the first step that needs it: a dead
   * implement agent fails the task, an assignment stranded in QA gets a fresh
   * QA agent, and a task with nothing running is advanced.
   */
  private async reconcileInProgress(task: TcpTask): Promise<void> {
    const plan = await this.state.planAssignments(task.id);

    // An implement assignment whose agent died mid-run fails the task.
    for (const assignment of plan) {
      if (assignment.status !== 'in-progress' || !assignment.agentId) continue;
      const agent = await this.agentRepo.findOneBy({ id: assignment.agentId });
      if (agent?.status === AgentStatus.Failed) {
        await this.failures.handleAgentFailed(
          agent.id,
          'agent failed before restart',
        );
        return;
      }
    }

    // An assignment left in QA with no live QA agent gets a fresh QA agent.
    for (const assignment of plan) {
      if (assignment.status !== 'in-qa') continue;
      const qa = await this.assignmentRepo.findOneBy({
        targetAssignmentId: assignment.id,
        mode: 'qa',
        status: 'in-progress',
      });
      const agent = qa?.agentId
        ? await this.agentRepo.findOneBy({ id: qa.agentId })
        : null;
      const qaDead = !agent || DEAD_AGENT_STATES.includes(agent.status);
      if (qaDead) await this.orchestration.assignmentReadyForQa(assignment);
      return;
    }

    // Nothing running: either dispatch the next ready step, or finalise.
    await this.orchestration.advance(task.id);
  }
}
