import {
  abortFailure,
  AgentStatus,
  AuditClientService,
  classifyRunError,
  type LlmConfig,
  type RunFailure,
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

/** What an aborted run's limits were, for its failure message. */
export interface AbortLimits {
  timeoutMs: number;
  maxIterations?: number;
  /** The call that repeated, when that is why the run was stopped. */
  repeatedCall?: { tool: string; result: string };
}

/**
 * Classifies an aborted run by why its signal was aborted: the wall-clock
 * timeout, the iteration limit, an overflowing context, a repeating call, or
 * a stop by someone (a forced drain).
 */
export function describeAbort(
  abortController: AbortController,
  limits: AbortLimits,
): RunFailure {
  return abortFailure(abortController.signal.reason, {
    seconds: Math.round(limits.timeoutMs / 1000),
    iterations: limits.maxIterations,
    tools: limits.repeatedCall && [limits.repeatedCall.tool],
    result: limits.repeatedCall?.result,
  });
}

/**
 * Classifies an error escaping the run. An aborted run surfaces as a generic
 * `AbortError` here rather than through `runSupervisedGraph`'s own result, so
 * the abort is checked first; anything else is classified by
 * {@link classifyRunError}.
 */
export function describeRunFailure(
  err: unknown,
  abortController: AbortController,
  limits: AbortLimits,
  llmConfig: LlmConfig,
): RunFailure {
  if (abortController.signal.aborted) {
    return describeAbort(abortController, limits);
  }
  return classifyRunError(err, llmConfig);
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
   * Marks the agent running, unless it was paused or finished after its job
   * was admitted — a user's pause landing in that gap must win, not be
   * overwritten. The check and the write are one statement.
   *
   * @returns Whether the agent is now running, so the run should go ahead.
   */
  async claimRunning(agent: TcpAgent, threadId: string): Promise<boolean> {
    const result = await this.agentRepo
      .createQueryBuilder()
      .update(TcpAgent)
      .set({ status: AgentStatus.Running, threadId })
      .where('id = :id', { id: agent.id })
      .andWhere('status NOT IN (:...finished)', {
        finished: [AgentStatus.Completed, AgentStatus.Cancelled],
      })
      // A live pause episode has `pausedAt`; a resume clears it first.
      .andWhere('NOT (status = :paused AND pausedAt IS NOT NULL)', {
        paused: AgentStatus.Paused,
      })
      .execute();
    if ((result.affected ?? 0) === 0) return false;
    this.auditClient.record(
      agent.companyId,
      agent.role.name,
      agent.id,
      AuditEventType.StateChange,
      { entity: 'agent', newStatus: AgentStatus.Running },
    );
    return true;
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
  async failRun(agent: TcpAgent, failure: RunFailure): Promise<void> {
    const reason = failure.message;
    try {
      await this.recordFailure(agent, failure);
    } catch (err) {
      // The failure itself couldn't be saved. tcp-server is still told, so
      // the task fails with its reason; the agent row may be left `running`
      // (see docs/outstanding-issues.md).
      this.logger.error(
        `Agent ${agent.id} failed (${failure.code}: ${reason}), and saving that failed: ${String(err)}`,
      );
      this.auditClient.notifyFailed(agent.id, reason);
    }
  }

  /** Writes the failure, unless the agent has already finished or paused. */
  private async recordFailure(
    agent: TcpAgent,
    failure: RunFailure,
  ): Promise<void> {
    const reason = failure.message;
    const fresh = await this.agentRepo.findOneBy({ id: agent.id });
    if (
      fresh?.status === AgentStatus.Completed ||
      fresh?.status === AgentStatus.Cancelled
    ) {
      this.logger.warn(
        `Agent ${agent.id} already ${fresh.status} — ignoring failure: ${reason}`,
      );
      return;
    }
    if (
      fresh?.status === AgentStatus.Paused &&
      (fresh.pauseReason === 'shutdown' || fresh.pauseReason === 'manual')
    ) {
      this.logger.warn(
        `Agent ${agent.id} stopped by a ${fresh.pauseReason} pause — staying paused rather than failing: ${reason}`,
      );
      return;
    }
    this.logger.error(
      `Agent ${agent.id} run failed (${failure.code}): ${reason}`,
    );
    // The terminal `failed` state_change (with reason) is recorded by
    // tcp-server's failAgent via notifyFailed below — no local duplicate.
    await this.updateStatus(agent, AgentStatus.Failed);
    this.auditClient.notifyFailed(agent.id, reason);
  }
}
