import {
  buildAssignmentShortcode,
  DEFAULT_TASK_MAX_QA_ATTEMPTS,
  renderQaRejectionMessage,
  resolveRunConfig,
  TcpAssignment,
  TcpCompany,
  TcpRole,
  TcpTask,
} from '@tcp/shared';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentOrchestrationService } from './agent-orchestration.service';
import { claimStatus } from './claim-status';
import { PauseAndResumeService } from './pause-and-resume.service';
import { TaskDeliverablesService } from './task-deliverables.service';
import { TaskStateService } from './task-state.service';

/**
 * Applies a QA agent's verdict to the assignment it reviewed: promote and
 * succeed on accept, or count the attempt and either retry or fail on reject.
 *
 * Deliberately stops at the assignment boundary — deciding what the *task*
 * does next after an accept is the orchestrator's call, so
 * {@link QaVerdictService.accept} reports whether the verdict landed rather
 * than advancing the task itself.
 */
@Injectable()
export class QaVerdictService {
  constructor(
    @InjectRepository(TcpTask)
    private readonly taskRepo: Repository<TcpTask>,
    @InjectRepository(TcpAssignment)
    private readonly assignmentRepo: Repository<TcpAssignment>,
    @InjectRepository(TcpCompany)
    private readonly companyRepo: Repository<TcpCompany>,
    @InjectRepository(TcpRole)
    private readonly roleRepo: Repository<TcpRole>,
    private readonly agents: AgentOrchestrationService,
    private readonly pauseResume: PauseAndResumeService,
    private readonly deliverables: TaskDeliverablesService,
    private readonly state: TaskStateService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Accept: promote the prepared working files into the assignment's completed
   * directory, record the approved artifacts, transition `in-qa → succeeded`
   * and complete the paused implementing agent. Returns `false` when the claim
   * was lost (a duplicate assure), so the caller knows not to advance the task.
   */
  async accept(target: TcpAssignment): Promise<boolean> {
    // Promotion is idempotent (same bytes), so it is safe to run before the
    // atomic claim below — a duplicate assure that loses the claim has done no
    // harm.
    const approved = await this.deliverables.promoteApproved(target);

    const claimed = await claimStatus(
      this.assignmentRepo,
      target.id,
      'in-qa',
      'succeeded',
    );
    if (claimed === 0) return false;

    await this.assignmentRepo.update(target.id, { approved });
    // The claim above only updated the DB row — reflect it in-memory too, so
    // recordAssignmentState's audit/SSE payloads report 'succeeded', not the
    // stale 'in-qa' `target` was loaded with.
    target.status = 'succeeded';
    await this.state.recordAssignmentState(
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

    await this.state.recomputeTaskStatus(target.taskId!);
    return true;
  }

  /**
   * Reject: increment `qaAttempts`; on exhaustion fail the assignment and its
   * task, otherwise return the assignment to `in-progress` and resume the
   * paused implementing agent with the QA feedback.
   */
  async reject(target: TcpAssignment): Promise<void> {
    const nextAttempts = target.qaAttempts + 1;
    const max = await this.resolveMaxQaAttempts(target);

    if (nextAttempts >= max) {
      await this.failOnExhaustedAttempts(target, nextAttempts);
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

    // Reflect the claimed DB update in-memory (see accept's note).
    target.status = 'in-progress';
    await this.state.recordAssignmentState(
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
    await this.state.recomputeTaskStatus(target.taskId!);
  }

  /**
   * The terminal branch of a rejection: the assignment has used up its QA
   * attempts, so it, its agent, and its task all fail.
   */
  private async failOnExhaustedAttempts(
    target: TcpAssignment,
    nextAttempts: number,
  ): Promise<void> {
    const failureReason = 'did not pass QA';
    const claimed = await this.assignmentRepo
      .createQueryBuilder()
      .update(TcpAssignment)
      .set({ status: 'failed', qaAttempts: nextAttempts, failureReason })
      .where('id = :id', { id: target.id })
      .andWhere('status = :inQa', { inQa: 'in-qa' })
      .execute();
    if ((claimed.affected ?? 0) === 0) return;

    // Reflect the claimed DB update in-memory (see accept's note).
    target.status = 'failed';
    target.failureReason = failureReason;
    await this.state.recordAssignmentState(
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
    await this.state.failTask(
      target.taskId!,
      `assignment ${target.id}: ${reason}`,
    );
  }

  /**
   * A qa-mode assignment's shortcode — it isn't itself in the plan, so it
   * shares the plan index of the implement step it targets (`orderIndex + 1`).
   * Null when the target isn't a task-linked, plan-indexed implement step
   * (shouldn't happen — only implement assignments are ever sent to QA).
   */
  async qaShortcode(target: TcpAssignment): Promise<string | null> {
    if (!target.taskId || target.orderIndex == null) return null;
    const task = await this.taskRepo.findOneBy({ id: target.taskId });
    if (!task) return null;
    return buildAssignmentShortcode(
      task.shortcode,
      'qa',
      target.orderIndex + 1,
    );
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
}
