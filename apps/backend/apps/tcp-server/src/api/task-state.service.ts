import {
  AuditEventType,
  buildAssignmentChangeSummary,
  buildTaskChangeSummary,
  deriveTaskStatus,
  TcpAssignment,
  TcpAssignmentStatus,
  TcpTask,
  TcpTaskStatus,
} from '@tcp/shared';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { claimStatus } from './claim-status';

/**
 * The orchestration stack's status-writing layer: every task/assignment status
 * change is claimed atomically here and recorded as an
 * {@link AuditEventType.StateChange} event in the same call, so a transition
 * can never be persisted without becoming visible to history and SSE.
 *
 * Collaborators own the *decisions*; this service owns making them stick.
 */
@Injectable()
export class TaskStateService {
  private readonly logger = new Logger(TaskStateService.name);

  constructor(
    @InjectRepository(TcpTask)
    private readonly taskRepo: Repository<TcpTask>,
    @InjectRepository(TcpAssignment)
    private readonly assignmentRepo: Repository<TcpAssignment>,
    private readonly audit: AuditService,
  ) {}

  /** The task's implement-mode plan assignments. */
  planAssignments(taskId: UUID): Promise<TcpAssignment[]> {
    return this.assignmentRepo.find({
      where: { taskId, mode: 'implement' },
    });
  }

  /**
   * Atomically moves an assignment `from → to` and records the transition;
   * returns `false` when the claim was lost (another writer won the race).
   */
  async transitionAssignment(
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

  /** Fails a task: atomically claims a non-terminal status → `failed`, records the reason. */
  async failTask(taskId: UUID, reason: string): Promise<void> {
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
  async recomputeTaskStatus(taskId: UUID): Promise<void> {
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
      // A task failed through its plan says why: the failed step's reason.
      const failureReason =
        next === 'failed'
          ? (plan.find((a) => a.status === 'failed')?.failureReason ?? null)
          : undefined;
      await this.taskRepo.update(taskId, {
        status: next,
        ...(failureReason !== undefined && { failureReason }),
      });
      await this.recordTaskState(
        task,
        next,
        failureReason ?? 'status recomputed',
      );
    }
  }

  /**
   * Records a task {@link AuditEventType.StateChange} event, and emits its
   * `task_changed` summary to both the task's own SSE stream and its
   * company's — this is the single place a task's status change reaches
   * `GET /api/task/:id/events` and `GET /api/company/:id/events`.
   */
  async recordTaskState(
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
  async recordAssignmentState(
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
