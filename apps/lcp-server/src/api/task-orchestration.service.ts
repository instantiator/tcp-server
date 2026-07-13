import {
  AgentStatus,
  assignmentCompletedKey,
  assignmentCompletedPrefix,
  assignmentWorkingKey,
  AuditEventType,
  DEFAULT_TASK_MAX_QA_ATTEMPTS,
  deriveTaskStatus,
  LcpAgent,
  LcpAssignment,
  LcpAssignmentStatus,
  LcpCompany,
  LcpMaterialArtifact,
  LcpRole,
  LcpTask,
  LcpTaskCompletedArtifact,
  LcpTaskStatus,
  resolveRunConfig,
  selectNextAssignments,
  taskCompletedKey,
} from '@lcp/shared';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { AgentOrchestrationService } from './agent-orchestration.service';
import { PauseAndResumeService } from './pause-and-resume.service';
import { TaskDispatcher } from './task-dispatcher.service';
import {
  renderQaPresentation,
  renderQaRejectionMessage,
} from './task-orchestration.prompts';

/** Agent statuses a recovery pass treats as "no longer live". */
const DEAD_AGENT_STATES: AgentStatus[] = [
  AgentStatus.Completed,
  AgentStatus.Failed,
];

/**
 * The real {@link TaskDispatcher}: drives the task lifecycle end-to-end —
 * planner → implement assignments → QA → finalisation, with QA reject/retry,
 * failure propagation, and startup recovery.
 *
 * Every handler re-reads current state and advances it with atomic conditional
 * UPDATEs (the `pausedAt`-claim pattern in {@link AgentOrchestrationService}),
 * so it is idempotent under duplicate/concurrent calls: only the caller that
 * actually flips a status proceeds to its side effects. Each task/assignment
 * transition is recorded as an {@link AuditEventType.StateChange} event.
 */
@Injectable()
export class TaskOrchestrationService
  extends TaskDispatcher
  implements OnModuleInit
{
  private readonly logger = new Logger(TaskOrchestrationService.name);

  constructor(
    @InjectRepository(LcpTask)
    private readonly taskRepo: Repository<LcpTask>,
    @InjectRepository(LcpAssignment)
    private readonly assignmentRepo: Repository<LcpAssignment>,
    @InjectRepository(LcpAgent)
    private readonly agentRepo: Repository<LcpAgent>,
    @InjectRepository(LcpCompany)
    private readonly companyRepo: Repository<LcpCompany>,
    @InjectRepository(LcpRole)
    private readonly roleRepo: Repository<LcpRole>,
    private readonly agents: AgentOrchestrationService,
    private readonly pauseResume: PauseAndResumeService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {
    super();
  }

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

  // Lifecycle hooks (TaskDispatcher)

  /**
   * Dispatches the planner for a freshly-started task: creates a plan-mode
   * assignment carrying the task's request and materials, then a plan agent for
   * it. Idempotent — no-op if a plan assignment already exists.
   */
  async dispatchPlanner(task: LcpTask): Promise<void> {
    const existing = await this.assignmentRepo.findOneBy({
      taskId: task.id,
      mode: 'plan',
    });
    if (existing) return;

    const company = await this.companyRepo.findOneByOrFail({
      id: task.companyId,
    });
    const plannerRoleId = task.plannerRoleId ?? company.plannerRoleId;
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
        prompt: task.request,
        roleId: plannerRoleId,
        status: 'in-progress',
        materials: task.materials,
        expected: [],
      }),
    );
    await this.recordAssignmentState(
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
  async taskPlanned(task: LcpTask): Promise<void> {
    await this.advance(task.id);
  }

  /**
   * Creates and dispatches a QA agent for an assignment that has just been
   * handed to QA (status `in-qa`, its implementing agent paused). Idempotent —
   * no-op if a live QA assignment already targets it.
   */
  async assignmentReadyForQa(assignment: LcpAssignment): Promise<void> {
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
        targetAssignmentId: assignment.id,
        roleId: assignment.roleId,
        status: 'in-progress',
        prompt: renderQaPresentation(assignment),
        materials: assignment.materials,
        expected: [],
      }),
    );
    await this.recordAssignmentState(qa, 'assignment dispatched (qa)');

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
  async assignmentAssured(assignment: LcpAssignment): Promise<void> {
    const target = await this.assignmentRepo.findOneBy({ id: assignment.id });
    if (!target || target.status !== 'in-qa') return;

    if (target.qaStatus === 'accepted') {
      await this.acceptAssignment(target);
    } else if (target.qaStatus === 'rejected') {
      await this.rejectAssignment(target);
    }
  }

  // Dispatch / accept / reject

  /**
   * Merges inherited materials into an assignment, atomically claims it
   * `ready → in-progress`, and dispatches its implement agent. No-op if the
   * claim is lost (another dispatch/recovery won).
   */
  private async dispatchAssignment(assignment: LcpAssignment): Promise<void> {
    const materials = await this.mergeMaterials(assignment);
    assignment.materials = materials;
    await this.assignmentRepo.update(assignment.id, {
      materials,
      qaStatus: null,
      qaFeedback: null,
    });

    const claimed = await this.transitionAssignment(
      assignment,
      'ready',
      'in-progress',
      'assignment dispatched (implement)',
    );
    if (!claimed) return;

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
   * Creates an agent for an assignment, back-links `assignment.agentId`, and
   * enqueues its start job. The back-link is done here (not in
   * `DbService.createAgent`, which only links auto-created orphan assignments)
   * so the assignment knows which agent is working it — the completion,
   * accept/reject, and QA paths all resolve the working agent through it.
   */
  private async dispatchAgentFor(
    assignment: LcpAssignment,
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

  /**
   * Accept: promote the prepared working files into the assignment's completed
   * directory, record the approved artifacts, transition `in-qa → succeeded`,
   * complete the paused implementing agent, then advance the task.
   */
  private async acceptAssignment(target: LcpAssignment): Promise<void> {
    const slug = await this.companySlug(target.companyId);

    // Copy is idempotent (same bytes), so it is safe to run before the atomic
    // claim below — a duplicate assure that loses the claim has done no harm.
    const approved: LcpAssignment['approved'] = [];
    for (const item of target.prepared) {
      if (item.type === 'inline-text') {
        approved.push({ type: 'inline-text', value: item.value });
        continue;
      }
      const source = assignmentWorkingKey(
        slug,
        target.taskId!,
        target.orderIndex!,
        item.value,
      );
      const destination = assignmentCompletedKey(
        slug,
        target.taskId!,
        target.orderIndex!,
        item.value,
      );
      await this.storage.copyFile(source, destination);
      approved.push({ type: 'assignment-completed-path', value: item.value });
    }

    const claimed = await this.claimAssignment(target.id, 'in-qa', 'succeeded');
    if (claimed === 0) return;

    await this.assignmentRepo.update(target.id, { approved });
    await this.recordAssignmentState(
      target,
      'assignment succeeded (QA accepted)',
    );

    // Complete the paused implementing agent through the shared completion path
    // (keeps SSE/consultation behaviour identical to a normal completion).
    if (target.agentId) {
      await this.pauseResume.completeAgent(
        target.agentId,
        target.summary ?? '',
      );
    }

    await this.recomputeTaskStatus(target.taskId!);
    await this.advance(target.taskId!);
  }

  /**
   * Reject: increment `qaAttempts`; on exhaustion fail the assignment and its
   * task, otherwise return the assignment to `in-progress` and resume the
   * paused implementing agent with the QA feedback.
   */
  private async rejectAssignment(target: LcpAssignment): Promise<void> {
    const nextAttempts = target.qaAttempts + 1;
    const max = await this.resolveMaxQaAttempts(target);

    if (nextAttempts >= max) {
      const claimed = await this.assignmentRepo
        .createQueryBuilder()
        .update(LcpAssignment)
        .set({ status: 'failed', qaAttempts: nextAttempts })
        .where('id = :id', { id: target.id })
        .andWhere('status = :inQa', { inQa: 'in-qa' })
        .execute();
      if ((claimed.affected ?? 0) === 0) return;

      await this.recordAssignmentState(
        target,
        'assignment failed (QA exhausted)',
        {
          qaFeedback: target.qaFeedback,
          qaAttempts: nextAttempts,
        },
      );
      const reason = `assignment failed QA after ${nextAttempts} attempt(s)`;
      if (target.agentId)
        await this.pauseResume.failAgent(target.agentId, reason);
      await this.failTask(target.taskId!, `assignment ${target.id}: ${reason}`);
      return;
    }

    const claimed = await this.assignmentRepo
      .createQueryBuilder()
      .update(LcpAssignment)
      .set({
        status: 'in-progress',
        qaAttempts: nextAttempts,
        qaStatus: null,
        qaFeedback: null,
      })
      .where('id = :id', { id: target.id })
      .andWhere('status = :inQa', { inQa: 'in-qa' })
      .execute();
    if ((claimed.affected ?? 0) === 0) return;

    await this.recordAssignmentState(
      target,
      'assignment returned to implement (QA rejected)',
      { qaAttempts: nextAttempts },
    );
    if (target.agentId) {
      await this.agents.resumeAgent(
        target.agentId,
        renderQaRejectionMessage(target.qaFeedback),
      );
    }
    await this.recomputeTaskStatus(target.taskId!);
  }

  // Advancement / finalisation

  /** Dispatches the next ready assignment(s), or finalises when the plan is done. */
  private async advance(taskId: UUID): Promise<void> {
    const plan = await this.planAssignments(taskId);
    const next = selectNextAssignments(plan);
    if (next.length > 0) {
      for (const assignment of next) await this.dispatchAssignment(assignment);
      return;
    }

    const task = await this.taskRepo.findOneBy({ id: taskId });
    if (!task) return;
    if (deriveTaskStatus(task.status, plan) === 'succeeded') {
      await this.finalise(task);
    }
  }

  /**
   * Copies every assignment's completed files into the task's completed
   * directory (highest `orderIndex` wins on a filename collision), records the
   * task's `completed` artifacts, and marks the task `succeeded`. Idempotent —
   * no-op once `completed` is set.
   */
  private async finalise(task: LcpTask): Promise<void> {
    if (task.completed != null) return;
    const slug = await this.companySlug(task.companyId);
    const plan = await this.planAssignments(task.id);
    // Ascending order so a later assignment's file overwrites an earlier one —
    // the "highest orderIndex wins" collision rule.
    const ordered = [...plan].sort(
      (a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0),
    );

    const filenames = new Set<string>();
    for (const assignment of ordered) {
      if (assignment.orderIndex == null) continue;
      const prefix = assignmentCompletedPrefix(
        slug,
        task.id,
        assignment.orderIndex,
      );
      const files = await this.storage.listFiles(prefix);
      for (const file of files) {
        await this.storage.copyFile(
          file.key,
          taskCompletedKey(slug, task.id, file.name),
        );
        filenames.add(file.name);
      }
    }

    const completed: LcpTaskCompletedArtifact[] = [
      ...[...filenames].map(
        (value): LcpTaskCompletedArtifact => ({
          type: 'task-completed-path',
          value,
        }),
      ),
      ...ordered.flatMap((a) =>
        a.approved
          .filter((art) => art.type === 'inline-text')
          .map(
            (art): LcpTaskCompletedArtifact => ({
              type: 'inline-text',
              value: art.value,
            }),
          ),
      ),
    ];

    await this.taskRepo.update(task.id, { completed, status: 'succeeded' });
    await this.recordTaskState(task, 'succeeded', 'task finalised');
    this.logger.log(`Task ${task.id} finalised (succeeded)`);
  }

  // Failure propagation

  /**
   * Propagates an agent-run failure to its task, when the failed agent's
   * assignment is task-linked. Called from the internal agent-failure endpoint
   * after the agent itself has been marked failed. Idempotent per transition.
   */
  async handleAgentFailed(agentId: UUID, reason: string): Promise<void> {
    const agent = await this.agentRepo.findOneBy({ id: agentId });
    if (!agent?.assignmentId) return;
    const assignment = await this.assignmentRepo.findOneBy({
      id: agent.assignmentId,
    });
    if (!assignment?.taskId) return;

    if (assignment.mode === 'plan') {
      await this.failTask(assignment.taskId, `planner failed: ${reason}`);
      return;
    }

    if (assignment.mode === 'implement') {
      const claimed = await this.transitionAssignment(
        assignment,
        'in-progress',
        'failed',
        'assignment failed (agent failed)',
      );
      if (!claimed) return;
      await this.failTask(
        assignment.taskId,
        `assignment ${assignment.id} failed: ${reason}`,
      );
      return;
    }

    // qa-mode: a failed QA agent fails the assignment it was reviewing.
    // ponytail: no QA-retry — a failed QA agent fails the task; re-dispatching
    // QA once is the upgrade path if this proves noisy.
    if (assignment.mode === 'qa' && assignment.targetAssignmentId) {
      const claimed = await this.claimAssignment(
        assignment.targetAssignmentId,
        'in-qa',
        'failed',
      );
      if (claimed === 0) return;
      await this.failTask(
        assignment.taskId,
        `QA agent failed for assignment ${assignment.targetAssignmentId}`,
      );
    }
  }

  // Startup recovery

  /**
   * Idempotent reconciliation of a single non-terminal task after a restart.
   * Agents in `Running`/`Paused` are left alone — BullMQ and pause/resume own
   * their recovery; this only repairs work no live agent will finish.
   */
  async reconcileTask(task: LcpTask): Promise<void> {
    if (task.status === 'planning') {
      const planner = await this.assignmentRepo.findOneBy({
        taskId: task.id,
        mode: 'plan',
      });
      const agent = planner?.agentId
        ? await this.agentRepo.findOneBy({ id: planner.agentId })
        : null;
      const plan = await this.planAssignments(task.id);
      const plannerDead =
        !agent ||
        agent.status === AgentStatus.Failed ||
        (agent.status === AgentStatus.Completed && plan.length === 0);
      if (plannerDead) {
        await this.failTask(task.id, 'planner did not produce a plan');
      }
      return;
    }

    if (task.status !== 'in-progress') return;
    const plan = await this.planAssignments(task.id);

    // An implement assignment whose agent died mid-run fails the task.
    for (const assignment of plan) {
      if (assignment.status !== 'in-progress' || !assignment.agentId) continue;
      const agent = await this.agentRepo.findOneBy({ id: assignment.agentId });
      if (agent?.status === AgentStatus.Failed) {
        await this.handleAgentFailed(agent.id, 'agent failed before restart');
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
      if (qaDead) await this.assignmentReadyForQa(assignment);
      return;
    }

    // Nothing running: either dispatch the next ready step, or finalise.
    await this.advance(task.id);
  }

  // Helpers

  /**
   * Builds an implement assignment's materials: the task's own materials, plus
   * the `assignment-completed-path` outputs of every prior succeeded implement
   * assignment, plus the planner's per-assignment hints already stored on it.
   * Deduplicated by `(type, value)`; the most-recent version of a duplicated
   * completed-path filename is resolved later by {@link resolveArtifactKey}, so
   * one entry per filename is enough here.
   */
  private async mergeMaterials(
    assignment: LcpAssignment,
  ): Promise<LcpMaterialArtifact[]> {
    if (!assignment.taskId) return assignment.materials;
    const task = await this.taskRepo.findOneBy({ id: assignment.taskId });
    const priors = (await this.planAssignments(assignment.taskId)).filter(
      (a) =>
        a.status === 'succeeded' &&
        a.orderIndex != null &&
        assignment.orderIndex != null &&
        a.orderIndex < assignment.orderIndex,
    );

    const merged: LcpMaterialArtifact[] = [
      ...(task?.materials ?? []),
      ...priors.flatMap((a) =>
        a.approved
          .filter((art) => art.type === 'assignment-completed-path')
          .map(
            (art): LcpMaterialArtifact => ({
              type: 'assignment-completed-path',
              value: art.value,
            }),
          ),
      ),
      ...assignment.materials,
    ];

    const seen = new Set<string>();
    return merged.filter((m) => {
      const key = `${m.type}::${m.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** Fails a task: atomically claims a non-terminal status → `failed`, records the reason. */
  private async failTask(taskId: UUID, reason: string): Promise<void> {
    const claimed = await this.taskRepo
      .createQueryBuilder()
      .update(LcpTask)
      .set({ status: 'failed', failureReason: reason })
      .where('id = :id', { id: taskId })
      .andWhere('status NOT IN (:...terminal)', {
        terminal: ['succeeded', 'failed', 'cancelled'],
      })
      .execute();
    if ((claimed.affected ?? 0) === 0) return;
    const task = await this.taskRepo.findOneBy({ id: taskId });
    if (task) await this.recordTaskState(task, 'failed', reason);
    this.logger.warn(`Task ${taskId} failed: ${reason}`);
  }

  /** Recomputes and persists a task's status from its plan (never past terminal). */
  private async recomputeTaskStatus(taskId: UUID): Promise<void> {
    const task = await this.taskRepo.findOneBy({ id: taskId });
    if (!task) return;
    const plan = await this.planAssignments(taskId);
    const next = deriveTaskStatus(task.status, plan);
    if (next !== task.status) {
      await this.taskRepo.update(taskId, { status: next });
      await this.recordTaskState(task, next, 'status recomputed');
    }
  }

  /** The task's implement-mode plan assignments. */
  private planAssignments(taskId: UUID): Promise<LcpAssignment[]> {
    return this.assignmentRepo.find({
      where: { taskId, mode: 'implement' },
    });
  }

  /** Atomic assignment status claim; returns rows affected (0 = lost the race). */
  private async claimAssignment(
    id: UUID,
    from: LcpAssignmentStatus,
    to: LcpAssignmentStatus,
  ): Promise<number> {
    const result = await this.assignmentRepo
      .createQueryBuilder()
      .update(LcpAssignment)
      .set({ status: to })
      .where('id = :id', { id })
      .andWhere('status = :from', { from })
      .execute();
    return result.affected ?? 0;
  }

  /**
   * Atomically moves an assignment `from → to` and records the transition;
   * returns `false` when the claim was lost (another writer won the race).
   */
  private async transitionAssignment(
    assignment: LcpAssignment,
    from: LcpAssignmentStatus,
    to: LcpAssignmentStatus,
    reason: string,
  ): Promise<boolean> {
    if ((await this.claimAssignment(assignment.id, from, to)) === 0) {
      return false;
    }
    assignment.status = to;
    await this.recordAssignmentState(assignment, reason);
    return true;
  }

  /** Resolves an assignment's max QA attempts: role → company → env → default. */
  private async resolveMaxQaAttempts(
    assignment: LcpAssignment,
  ): Promise<number> {
    const role = await this.roleRepo.findOneBy({ id: assignment.roleId });
    const company = await this.companyRepo.findOneBy({
      id: assignment.companyId,
    });
    const raw = this.config.get<string>('TASK_MAX_QA_ATTEMPTS');
    const env = raw != null && raw !== '' ? Number(raw) : undefined;
    return resolveRunConfig(
      'maxQaAttempts',
      role,
      company,
      Number.isFinite(env) ? env : undefined,
      DEFAULT_TASK_MAX_QA_ATTEMPTS,
    );
  }

  private async companySlug(companyId: UUID): Promise<string> {
    const company = await this.companyRepo.findOneByOrFail({ id: companyId });
    return company.slug;
  }

  /** Records a task {@link AuditEventType.StateChange} event. */
  private async recordTaskState(
    task: LcpTask,
    newStatus: LcpTaskStatus,
    reason: string,
  ): Promise<void> {
    await this.audit.record(
      task.companyId,
      'orchestrator',
      null,
      AuditEventType.StateChange,
      { taskId: task.id, newStatus, reason },
    );
  }

  /** Records an assignment {@link AuditEventType.StateChange} event. */
  private async recordAssignmentState(
    assignment: LcpAssignment,
    reason: string,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(
      assignment.companyId,
      'orchestrator',
      assignment.agentId ?? null,
      AuditEventType.StateChange,
      {
        assignmentId: assignment.id,
        taskId: assignment.taskId ?? null,
        newStatus: assignment.status,
        reason,
        ...extra,
      },
    );
  }
}
