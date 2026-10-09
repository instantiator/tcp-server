import {
  AgentStatus,
  AuditClientService,
  AuditEventType,
  DEFAULT_RATE_LIMIT_QUOTA_RETRY_MS,
  DEFAULT_RATE_LIMIT_RETRY_MAX_MS,
  DEFAULT_RATE_LIMIT_RETRY_MS,
  markQueued,
  rateLimitRetryAt,
  TcpAgent,
  type RateLimit,
  type RateLimitCadence,
} from '@tcp/shared';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

/**
 * Statuses whose terminal `state_change` is recorded by tcp-server (via
 * notifyComplete/notifyFailed), so {@link AgentRunStatusService.updateStatus}
 * must not record a duplicate for them.
 */
const TERMINAL_STATUSES = new Set<AgentStatus>([
  AgentStatus.Completed,
  AgentStatus.Failed,
  AgentStatus.Cancelled,
]);

/**
 * Builds a human-readable reason for an abort with no more specific
 * `failureReason` from `runSupervisedGraph` (e.g. the wall-clock timeout
 * firing, which aborts the signal directly rather than returning through the
 * graph runner).
 */
export function describeAbort(
  abortController: AbortController,
  timeoutMs: number,
): string {
  if (abortController.signal.reason === 'timeout') {
    return `timed out after ${Math.round(timeoutMs / 1000)} seconds`;
  }
  return String(abortController.signal.reason ?? 'unknown');
}

/**
 * Builds a human-readable failure reason for an error escaping the run — a
 * timed-out abort surfaces as a generic `AbortError` here rather than through
 * `runSupervisedGraph`'s own result, so it's checked first; anything else falls
 * back to the error's own message, or a generic "unexpected LLM failure" when
 * the error carries no useful message.
 */
export function describeRunFailure(
  err: unknown,
  abortController: AbortController,
  timeoutMs: number,
): string {
  if (abortController.signal.aborted) {
    return describeAbort(abortController, timeoutMs);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return msg.trim() ? msg : 'unexpected LLM failure';
}

/**
 * Writes an agent run's lifecycle status, and decides which transitions this
 * worker is responsible for auditing — tcp-server records the terminal ones
 * itself once notified, so recording them here too would double them up.
 */
@Injectable()
export class AgentRunStatusService {
  private readonly logger = new Logger(AgentRunStatusService.name);

  constructor(
    private readonly auditClient: AuditClientService,
    @InjectRepository(TcpAgent)
    private readonly agentRepo: Repository<TcpAgent>,
    private readonly config: ConfigService,
  ) {}

  /**
   * Persists a new lifecycle status for the agent to the database.
   * Optionally also sets the LangGraph `threadId` (used on the first run to
   * bind the agent's UUID as the checkpoint thread identifier).
   */
  async updateStatus(
    agent: TcpAgent,
    status: AgentStatus,
    threadId?: string,
  ): Promise<void> {
    await this.agentRepo.update(agent.id, {
      status,
      ...(threadId !== undefined && { threadId }),
    });
    // Record non-terminal transitions (e.g. running) as a state_change the
    // server streams live. Terminal transitions (completed/failed/cancelled)
    // are recorded by tcp-server's completeAgent/failAgent once
    // notifyComplete/notifyFailed lands — carrying the response/reason — so we
    // don't duplicate them here.
    if (!TERMINAL_STATUSES.has(status)) {
      this.auditClient.record(
        agent.companyId,
        agent.role.name,
        agent.id,
        AuditEventType.StateChange,
        { entity: 'agent', newStatus: status },
      );
    }
  }

  /**
   * Shows the agent as waiting for a model slot, recording the change so open
   * pages see it. A no-op when the agent has moved on (see {@link markQueued}),
   * or is already queued from an earlier check of the same job.
   */
  async markQueued(agent: TcpAgent): Promise<void> {
    if (!(await markQueued(this.agentRepo, agent.id))) return;
    this.auditClient.record(
      agent.companyId,
      agent.role.name,
      agent.id,
      AuditEventType.StateChange,
      { entity: 'agent', newStatus: AgentStatus.Queued },
    );
  }

  /**
   * Pauses an agent whose provider refused a call, instead of failing it, and
   * records when it should try again. The LangGraph checkpoint is untouched,
   * so a resume continues from the last completed step.
   *
   * Leaves an agent alone that has finished or that a drain has paused, as
   * {@link failRun} does — the rate limit is not why it stopped.
   *
   * @param progressed - Whether this run got any LLM response before the
   *   refusal; if so the backoff starts again from its first step.
   */
  async pauseForRateLimit(
    agent: TcpAgent,
    limit: RateLimit,
    progressed: boolean,
  ): Promise<void> {
    const fresh = await this.agentRepo.findOneBy({ id: agent.id });
    if (
      !fresh ||
      TERMINAL_STATUSES.has(fresh.status) ||
      fresh.status === AgentStatus.Paused
    ) {
      return;
    }
    const attempt = progressed ? 1 : (fresh.rateLimitRetries ?? 0) + 1;
    const resumeAfter = this.autoResume()
      ? rateLimitRetryAt(limit, attempt, this.cadence())
      : null;

    await this.agentRepo
      .createQueryBuilder()
      .update(TcpAgent)
      .set({
        status: AgentStatus.Paused,
        pausedAt: new Date(),
        pauseReason: 'rate_limited',
        // Null when auto-resume is off: only an explicit resume lifts it.
        resumeAfter: resumeAfter ?? (() => 'NULL'),
        rateLimitRetries: attempt,
      })
      .where('id = :id', { id: agent.id })
      .execute();
    this.auditClient.record(
      agent.companyId,
      agent.role.name,
      agent.id,
      AuditEventType.StateChange,
      {
        entity: 'agent',
        newStatus: AgentStatus.Paused,
        reason: 'rate_limited',
        rateLimit: limit.kind,
        resumeAfter: resumeAfter?.toISOString() ?? null,
      },
    );
    this.logger.warn(
      `Agent ${agent.id} paused: provider ${limit.kind === 'quota' ? 'quota used up' : 'rate limit'}; ${resumeAfter ? `retrying at ${resumeAfter.toISOString()}` : 'auto-resume is off'}`,
    );
  }

  /**
   * Whether rate-limited agents resume by themselves. Read leniently: compose
   * passes an unset variable as '', which must mean the default (on).
   */
  private autoResume(): boolean {
    const raw = this.config.get<boolean | string>('RATE_LIMIT_AUTO_RESUME');
    return String(raw ?? '').toLowerCase() !== 'false';
  }

  /** The retry cadence, from the environment or the defaults. */
  private cadence(): RateLimitCadence {
    const ms = (key: string, fallback: number) =>
      Number(this.config.get<number | string>(key)) || fallback;
    return {
      retryMs: ms('RATE_LIMIT_RETRY_MS', DEFAULT_RATE_LIMIT_RETRY_MS),
      retryMaxMs: ms(
        'RATE_LIMIT_RETRY_MAX_MS',
        DEFAULT_RATE_LIMIT_RETRY_MAX_MS,
      ),
      quotaRetryMs: ms(
        'RATE_LIMIT_QUOTA_RETRY_MS',
        DEFAULT_RATE_LIMIT_QUOTA_RETRY_MS,
      ),
    };
  }

  /**
   * Marks the run as failed: records the state change, sets the agent status,
   * and notifies tcp-server (which resolves any pending consultation as failed,
   * resumes the calling agent, and emits the terminal `failed` event to any SSE
   * clients observing this agent).
   *
   * No-op if the agent has already reached Completed — `complete_assignment` may
   * have won the race against a late failure (e.g. a summary error).
   *
   * Also a no-op for an agent a shutdown drain has paused. A forced drain stops
   * the run by aborting its signal, which surfaces here as an ordinary run
   * failure; recording it as {@link AgentStatus.Failed} would bury the reason
   * the run really stopped and lose the pause the operator is meant to resume
   * from.
   */
  async failRun(agent: TcpAgent, reason: string): Promise<void> {
    const fresh = await this.agentRepo.findOneBy({ id: agent.id });
    if (fresh?.status === AgentStatus.Completed) {
      this.logger.warn(
        `Agent ${agent.id} already completed — ignoring failure: ${reason}`,
      );
      return;
    }
    if (
      fresh?.status === AgentStatus.Paused &&
      fresh.pauseReason === 'shutdown'
    ) {
      this.logger.warn(
        `Agent ${agent.id} stopped by a shutdown — staying paused rather than failing: ${reason}`,
      );
      return;
    }
    this.logger.error(`Agent ${agent.id} run failed: ${reason}`);
    // The terminal `failed` state_change (with reason) is recorded by
    // tcp-server's failAgent via notifyFailed below — no local duplicate.
    await this.updateStatus(agent, AgentStatus.Failed);
    this.auditClient.notifyFailed(agent.id, reason);
  }
}
