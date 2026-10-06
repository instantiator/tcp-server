import {
  AgentStatus,
  AuditClientService,
  AuditEventType,
  markQueued,
  TcpAgent,
} from '@tcp/shared';
import { Injectable, Logger } from '@nestjs/common';
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
