import {
  AgentStatus,
  assignmentCompletedKey,
  assignmentCompletedPrefix,
  assignmentWorkingKey,
  AuditEventType,
  buildAssignmentChangeSummary,
  buildAssignmentShortcode,
  buildTaskChangeSummary,
  DEFAULT_TASK_MAX_QA_ATTEMPTS,
  deriveTaskStatus,
  TcpAgent,
  TcpAssignment,
  TcpAssignmentStatus,
  TcpCompany,
  TcpMaterialArtifact,
  TcpRole,
  TcpTask,
  TcpTaskCompletedArtifact,
  TcpTaskStatus,
  renderQaPresentation,
  renderQaRejectionMessage,
  resolveRunConfig,
  selectNextAssignments,
  taskCompletedKey,
  taskCompletedPrefix,
} from '@tcp/shared';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { AgentOrchestrationService } from './agent-orchestration.service';
import { claimStatus } from './claim-status';
import { PauseAndResumeService } from './pause-and-resume.service';
import { TaskDispatcher } from './task-dispatcher.service';

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
    @InjectRepository(TcpTask)
    private readonly taskRepo: Repository<TcpTask>,
    @InjectRepository(TcpAssignment)
    private readonly assignmentRepo: Repository<TcpAssignment>,
    @InjectRepository(TcpAgent)
    private readonly agentRepo: Repository<TcpAgent>,
    @InjectRepository(TcpCompany)
    private readonly companyRepo: Repository<TcpCompany>,
    @InjectRepository(TcpRole)
    private readonly roleRepo: Repository<TcpRole>,
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
  async dispatchPlanner(task: TcpTask): Promise<void> {
    const existing = await this.assignmentRepo.findOneBy({
      taskId: task.id,
      mode: 'plan',
    });
    if (existing) return;

    // TaskService.start already claimed ready → planning atomically before
    // calling here; this is the one place that reaction is recorded/emitted
    // (guarded by the same idempotency check as the rest of this method).
    await this.recordTaskState(task, 'planning', 'task started');

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
        shortcode: buildAssignmentShortcode(task.shortcode, 'plan', 0),
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
        shortcode: await this.qaShortcode(assignment),
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
  async assignmentAssured(assignment: TcpAssignment): Promise<void> {
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
  private async dispatchAssignment(assignment: TcpAssignment): Promise<void> {
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

    await this.recomputeTaskStatus(assignment.taskId!);

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

  /**
   * Accept: promote the prepared working files into the assignment's completed
   * directory, record the approved artifacts, transition `in-qa → succeeded`,
   * complete the paused implementing agent, then advance the task.
   */
  private async acceptAssignment(target: TcpAssignment): Promise<void> {
    const slug = await this.companySlug(target.companyId);

    // Copy is idempotent (same bytes), so it is safe to run before the atomic
    // claim below — a duplicate assure that loses the claim has done no harm.
    const approved: TcpAssignment['approved'] = [];
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

    const claimed = await claimStatus(
      this.assignmentRepo,
      target.id,
      'in-qa',
      'succeeded',
    );
    if (claimed === 0) return;

    await this.assignmentRepo.update(target.id, { approved });
    // The claim above only updated the DB row — reflect it in-memory too, so
    // recordAssignmentState's audit/SSE payloads report 'succeeded', not the
    // stale 'in-qa' `target` was loaded with.
    target.status = 'succeeded';
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
  private async rejectAssignment(target: TcpAssignment): Promise<void> {
    const nextAttempts = target.qaAttempts + 1;
    const max = await this.resolveMaxQaAttempts(target);

    if (nextAttempts >= max) {
      const failureReason = 'did not pass QA';
      const claimed = await this.assignmentRepo
        .createQueryBuilder()
        .update(TcpAssignment)
        .set({ status: 'failed', qaAttempts: nextAttempts, failureReason })
        .where('id = :id', { id: target.id })
        .andWhere('status = :inQa', { inQa: 'in-qa' })
        .execute();
      if ((claimed.affected ?? 0) === 0) return;

      // Reflect the claimed DB update in-memory (see acceptAssignment's note).
      target.status = 'failed';
      target.failureReason = failureReason;
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
      .update(TcpAssignment)
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

    // Reflect the claimed DB update in-memory (see acceptAssignment's note).
    target.status = 'in-progress';
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

  /**
   * Dispatches the next ready assignment(s); when the plan is complete either
   * dispatches a finalise agent (task has expected outputs) or finalises
   * mechanically (no expected outputs).
   */
  private async advance(taskId: UUID): Promise<void> {
    const plan = await this.planAssignments(taskId);
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
   * Copies every assignment's completed files into the task's completed
   * directory (highest `orderIndex` wins on a filename collision). Idempotent —
   * a re-copy writes the same bytes. Returns the set of copied filenames.
   */
  private async promoteToTaskCompleted(task: TcpTask): Promise<void> {
    const slug = await this.companySlug(task.companyId);
    const plan = await this.planAssignments(task.id);
    // Ascending order so a later assignment's file overwrites an earlier one —
    // the "highest orderIndex wins" collision rule.
    const ordered = [...plan].sort(
      (a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0),
    );
    for (const assignment of ordered) {
      if (assignment.orderIndex == null) continue;
      const files = await this.storage.listFiles(
        assignmentCompletedPrefix(slug, task.id, assignment.orderIndex),
      );
      for (const file of files) {
        await this.storage.copyFile(
          file.key,
          taskCompletedKey(slug, task.id, file.name),
        );
      }
    }
  }

  /**
   * Builds the task's `completed` artifact list from the files currently in its
   * completed/ directory (so a finalise agent's renames/edits are reflected)
   * plus any approved `inline-text` from the plan assignments.
   */
  private async buildTaskCompleted(
    task: TcpTask,
  ): Promise<TcpTaskCompletedArtifact[]> {
    const slug = await this.companySlug(task.companyId);
    const files = await this.storage.listFiles(
      taskCompletedPrefix(slug, task.id),
    );
    const plan = await this.planAssignments(task.id);
    return [
      ...files.map((f): TcpTaskCompletedArtifact => ({
        type: 'task-completed-path',
        value: f.name,
      })),
      ...plan.flatMap((a) =>
        a.approved
          .filter((art) => art.type === 'inline-text')
          .map((art): TcpTaskCompletedArtifact => ({
            type: 'inline-text',
            value: art.value,
          })),
      ),
    ];
  }

  /**
   * Finalises a task with no stated `expected` outputs: promote the assignment
   * deliverables, record `completed`, mark `succeeded`. Idempotent — no-op once
   * `completed` is set.
   */
  private async finaliseMechanical(task: TcpTask): Promise<void> {
    if (task.completed != null) return;
    await this.promoteToTaskCompleted(task);
    const completed = await this.buildTaskCompleted(task);
    await this.taskRepo.update(task.id, { completed, status: 'succeeded' });
    await this.recordTaskState(task, 'succeeded', 'task finalised');
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

    await this.promoteToTaskCompleted(task);
    await this.taskRepo.update(task.id, { status: 'finalising' });
    await this.recordTaskState(
      task,
      'finalising',
      'dispatching finalise agent',
    );

    const company = await this.companyRepo.findOneByOrFail({
      id: task.companyId,
    });
    const roleId = task.plannerRoleId ?? company.plannerRoleId;
    if (!roleId) {
      throw new Error(`Task ${task.id} has no resolvable role for finalise`);
    }

    const expectedLines = task.expected
      .map((e) =>
        e.type === 'task-completed-path'
          ? `- file: ${e.value}`
          : `- text: ${e.value || '(any text)'}`,
      )
      .join('\n');
    const prompt = `Task: ${task.request}\n\nThe task's expected outputs — make the completed deliverables meet or exceed these:\n${expectedLines}`;

    // One past the last implement step — finalise runs after the whole plan.
    const planIndex = (await this.planAssignments(task.id)).length + 1;
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
    await this.recordAssignmentState(
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

  /**
   * Reaction to a finalise agent completing (its assignment already claimed
   * `succeeded`): record the task's final `completed` set from the completed/
   * directory, mark the task `succeeded`, and complete the finalise agent.
   */
  async assignmentFinalised(finalise: TcpAssignment): Promise<void> {
    if (!finalise.taskId) return;
    const task = await this.taskRepo.findOneBy({ id: finalise.taskId });
    if (!task) return;
    const completed = await this.buildTaskCompleted(task);
    await this.taskRepo.update(task.id, { completed, status: 'succeeded' });
    await this.recordTaskState(
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

  // Failure propagation

  /**
   * Propagates an agent-run failure to its task, when the failed agent's
   * assignment is task-linked. Idempotent per transition.
   */
  async handleAgentFailed(agentId: UUID, reason: string): Promise<void> {
    const agent = await this.agentRepo.findOneBy({ id: agentId });
    if (!agent?.assignmentId) return;
    const assignment = await this.assignmentRepo.findOneBy({
      id: agent.assignmentId,
    });
    if (!assignment?.taskId) return;

    if (assignment.mode === 'plan') {
      const claimed = await this.transitionAssignment(
        assignment,
        'in-progress',
        'failed',
        'assignment failed (agent failed)',
        reason,
      );
      if (!claimed) return;
      await this.failTask(assignment.taskId, `planner failed: ${reason}`);
      return;
    }

    // finalise-mode: the task fails, but the files it already promoted stay —
    // record `completed` from the completed/ directory before failing. The
    // finalise assignment itself must transition `in-progress → failed` too,
    // or it's left stuck `in-progress` while its task reads `failed`.
    if (assignment.mode === 'finalise') {
      const claimed = await this.transitionAssignment(
        assignment,
        'in-progress',
        'failed',
        'assignment failed (agent failed)',
        reason,
      );
      if (!claimed) return;
      const task = await this.taskRepo.findOneBy({ id: assignment.taskId });
      if (task) {
        const completed = await this.buildTaskCompleted(task);
        await this.taskRepo.update(task.id, { completed });
      }
      await this.failTask(assignment.taskId, `finalise failed: ${reason}`);
      return;
    }

    if (assignment.mode === 'implement') {
      const claimed = await this.transitionAssignment(
        assignment,
        'in-progress',
        'failed',
        'assignment failed (agent failed)',
        reason,
      );
      if (!claimed) return;
      await this.failTask(
        assignment.taskId,
        `assignment ${assignment.id} failed: ${reason}`,
      );
      return;
    }

    // qa-mode: a failed QA agent fails the assignment it was reviewing, its
    // own qa assignment, and the task. The target's `in-qa → failed` claim is
    // the gate: if the target is no longer in-qa (a concurrent QA accept won
    // the race), this is a no-op — nothing is failed, matching that the
    // reviewed assignment already passed.
    // ponytail: no QA-retry — a failed QA agent fails the task; re-dispatching
    // QA once is the upgrade path if this proves noisy.
    if (assignment.mode === 'qa' && assignment.targetAssignmentId) {
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
      await this.transitionAssignment(
        assignment,
        'in-progress',
        'failed',
        'assignment failed (agent failed)',
        reason,
      );
      await this.failTask(
        assignment.taskId,
        `QA agent failed for assignment ${assignment.targetAssignmentId}`,
      );
    }
  }

  /**
   * Belt-and-braces runtime check for a planner that reached `Completed`
   * WITHOUT producing a plan. Called from the internal agent-completion
   * endpoint. This is normally impossible — `plan` mode has no pause vector
   * (the plan-mode tool filter drops consultation and user queries) and the
   * `create_plan` required-tool
   * enforcement fails such a run instead — but if it ever happens, fail the
   * task now rather than leaving it wedged in `planning` until restart
   * reconciliation ({@link reconcileTask}, same predicate). Idempotent via
   * {@link failTask}; a no-op for every non-planner completion.
   */
  async handleAgentCompleted(agentId: UUID): Promise<void> {
    const agent = await this.agentRepo.findOneBy({ id: agentId });
    if (!agent?.assignmentId) return;
    const assignment = await this.assignmentRepo.findOneBy({
      id: agent.assignmentId,
    });
    if (assignment?.mode !== 'plan' || !assignment.taskId) return;

    const task = await this.taskRepo.findOneBy({ id: assignment.taskId });
    if (task?.status !== 'planning') return;

    const plan = await this.planAssignments(assignment.taskId);
    if (plan.length === 0) {
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
      await this.recordAssignmentState(
        assignment,
        'assignment failed (planner produced no plan)',
      );
      await this.failTask(
        assignment.taskId,
        'planner completed without producing a plan',
      );
    }
  }

  // Startup recovery

  /**
   * Idempotent reconciliation of a single non-terminal task after a restart.
   * Agents in `Running`/`Paused` are left alone — BullMQ and pause/resume own
   * their recovery; this only repairs work no live agent will finish.
   */
  async reconcileTask(task: TcpTask): Promise<void> {
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
        // Fail the plan assignment too (no-op if it isn't in-progress, e.g. a
        // planner that completed without a plan), so it isn't left stuck
        // `in-progress` while its task reads `failed`.
        if (planner) {
          await this.transitionAssignment(
            planner,
            'in-progress',
            'failed',
            'assignment failed (agent died before restart)',
            'agent died before restart',
          );
        }
        await this.failTask(task.id, 'planner did not produce a plan');
      }
      return;
    }

    if (task.status === 'finalising') {
      // A finalise agent that died mid-run fails the task (its files were
      // already promoted); a live one is left to BullMQ/pause-resume.
      const finalise = await this.assignmentRepo.findOneBy({
        taskId: task.id,
        mode: 'finalise',
      });
      const agent = finalise?.agentId
        ? await this.agentRepo.findOneBy({ id: finalise.agentId })
        : null;
      if (finalise && (!agent || DEAD_AGENT_STATES.includes(agent.status))) {
        // Fail the finalise assignment too — otherwise it's left stuck
        // `in-progress` while its task reads `failed` (same as the live
        // handleAgentFailed path).
        await this.transitionAssignment(
          finalise,
          'in-progress',
          'failed',
          'assignment failed (agent died before restart)',
          'agent died before restart',
        );
        const completed = await this.buildTaskCompleted(task);
        await this.taskRepo.update(task.id, { completed });
        await this.failTask(task.id, 'finalise agent died before restart');
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
    assignment: TcpAssignment,
  ): Promise<TcpMaterialArtifact[]> {
    if (!assignment.taskId) return assignment.materials;
    const task = await this.taskRepo.findOneBy({ id: assignment.taskId });
    const priors = (await this.planAssignments(assignment.taskId)).filter(
      (a) =>
        a.status === 'succeeded' &&
        a.orderIndex != null &&
        assignment.orderIndex != null &&
        a.orderIndex < assignment.orderIndex,
    );

    const merged: TcpMaterialArtifact[] = [
      ...(task?.materials ?? []),
      ...priors.flatMap((a) =>
        a.approved
          .filter((art) => art.type === 'assignment-completed-path')
          .map((art): TcpMaterialArtifact => ({
            type: 'assignment-completed-path',
            value: art.value,
          })),
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
      await this.recordAssignmentState(assignment, 'task cancelled');

      if (assignment.agentId) {
        await this.agentRepo
          .createQueryBuilder()
          .update(TcpAgent)
          .set({ status: AgentStatus.Cancelled })
          .where('id = :id', { id: assignment.agentId })
          .andWhere('status NOT IN (:...terminal)', {
            terminal: [
              AgentStatus.Completed,
              AgentStatus.Failed,
              AgentStatus.Cancelled,
            ],
          })
          .execute();
      }
    }
    await this.recordTaskState(task, 'cancelled', 'task cancelled');
  }

  /** Fails a task: atomically claims a non-terminal status → `failed`, records the reason. */
  private async failTask(taskId: UUID, reason: string): Promise<void> {
    const claimed = await this.taskRepo
      .createQueryBuilder()
      .update(TcpTask)
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
    let next = deriveTaskStatus(task.status, plan);
    // When the plan completes but the task states expected outputs, hold it in
    // `finalising` (not `succeeded`) — a finalise agent must first bring the
    // deliverables up to those outputs. Guarded so an already-`succeeded` task
    // (finalise done) is never reverted.
    if (
      next === 'succeeded' &&
      task.status !== 'succeeded' &&
      (task.expected?.length ?? 0) > 0
    ) {
      next = 'finalising';
    }
    if (next !== task.status) {
      await this.taskRepo.update(taskId, { status: next });
      await this.recordTaskState(task, next, 'status recomputed');
    }
  }

  /** The task's implement-mode plan assignments. */
  private planAssignments(taskId: UUID): Promise<TcpAssignment[]> {
    return this.assignmentRepo.find({
      where: { taskId, mode: 'implement' },
    });
  }

  /**
   * Atomically moves an assignment `from → to` and records the transition;
   * returns `false` when the claim was lost (another writer won the race).
   */
  private async transitionAssignment(
    assignment: TcpAssignment,
    from: TcpAssignmentStatus,
    to: TcpAssignmentStatus,
    reason: string,
    failureReason?: string,
  ): Promise<boolean> {
    const extra =
      to === 'failed' && failureReason ? { failureReason } : undefined;
    if (
      (await claimStatus(
        this.assignmentRepo,
        assignment.id,
        from,
        to,
        extra,
      )) === 0
    ) {
      return false;
    }
    assignment.status = to;
    if (extra) assignment.failureReason = extra.failureReason;
    await this.recordAssignmentState(assignment, reason);
    return true;
  }

  /** Resolves an assignment's max QA attempts: role → company → env → default. */
  private async resolveMaxQaAttempts(
    assignment: TcpAssignment,
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

  /**
   * A qa-mode assignment's shortcode — it isn't itself in the plan, so it
   * shares the plan index of the implement step it targets (`orderIndex + 1`).
   * Null when the target isn't a task-linked, plan-indexed implement step
   * (shouldn't happen — only implement assignments are ever sent to QA).
   */
  private async qaShortcode(target: TcpAssignment): Promise<string | null> {
    if (!target.taskId || target.orderIndex == null) return null;
    const task = await this.taskRepo.findOneBy({ id: target.taskId });
    if (!task) return null;
    return buildAssignmentShortcode(
      task.shortcode,
      'qa',
      target.orderIndex + 1,
    );
  }

  /**
   * Records a task {@link AuditEventType.StateChange} event, and emits its
   * `task_changed` summary to both the task's own SSE stream and its
   * company's — this is the single place a task's status change reaches
   * `GET /api/task/:id/events` and `GET /api/company/:id/events`.
   */
  private async recordTaskState(
    task: TcpTask,
    newStatus: TcpTaskStatus,
    reason: string,
  ): Promise<void> {
    const plan = await this.planAssignments(task.id);
    const summary = buildTaskChangeSummary(
      { ...task, status: newStatus },
      plan,
    );
    // One write. The publisher routes an `entity:'task'` row to both the task
    // and company channels (A.6), so no separate SSE emits are needed; the
    // summary rides in the payload for the summary-level task/company views.
    await this.audit.record(
      task.companyId,
      'orchestrator',
      null,
      AuditEventType.StateChange,
      { entity: 'task', taskId: task.id, newStatus, reason, summary },
      { taskId: task.id },
    );
  }

  /**
   * Records an assignment {@link AuditEventType.StateChange} event, and — for
   * a task-linked assignment — emits its `assignment_changed` summary to the
   * task's SSE stream (orphan assignments have no task stream to reach).
   */
  private async recordAssignmentState(
    assignment: TcpAssignment,
    reason: string,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    // One write. An `entity:'assignment'` row with a taskId reaches the task
    // channel via the publisher (A.6); the summary rides in the payload.
    await this.audit.record(
      assignment.companyId,
      'orchestrator',
      assignment.agentId ?? null,
      AuditEventType.StateChange,
      {
        entity: 'assignment',
        assignmentId: assignment.id,
        taskId: assignment.taskId ?? null,
        newStatus: assignment.status,
        reason,
        summary: buildAssignmentChangeSummary(assignment),
        ...extra,
      },
      { assignmentId: assignment.id, taskId: assignment.taskId ?? null },
    );
  }
}
