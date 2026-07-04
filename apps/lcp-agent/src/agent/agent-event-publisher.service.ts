import { AgentEvent, agentEventsChannel } from '@lcp/shared';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UUID } from 'crypto';
import Redis from 'ioredis';

/**
 * Publishes agent observability events (LLM activity, reasoning/response
 * deltas, worker status transitions) to the per-agent Redis channel returned
 * by {@link agentEventsChannel}, where lcp-server's `AgentEventService` relays
 * them to connected SSE clients.
 *
 * A single connection is opened lazily on first publish and reused — unlike a
 * per-message transient connection, this suits the high frequency of token
 * deltas. When `REDIS_URL` is unset (e.g. unit tests) every publish is a no-op.
 * Publishing is fire-and-forget: an observability failure must never fail the
 * agent loop.
 */
@Injectable()
export class AgentEventPublisherService implements OnModuleDestroy {
  private readonly logger = new Logger(AgentEventPublisherService.name);
  private connection: Redis | null = null;
  private disabled = false;

  constructor(private readonly config: ConfigService) {}

  /**
   * Returns the shared publisher connection, opening it on first use.
   * Returns null (and stays disabled) when `REDIS_URL` is not configured.
   */
  private getConnection(): Redis | null {
    if (this.disabled) return null;
    if (this.connection) return this.connection;

    const url = this.config.get<string>('REDIS_URL');
    if (!url) {
      this.disabled = true;
      return null;
    }

    this.connection = new Redis(url);
    // An unhandled 'error' (e.g. "Connection is closed") would otherwise crash
    // the process; the channel is best-effort, so log and swallow.
    this.connection.on('error', (err: Error) => {
      this.logger.warn(`Event publisher connection error: ${err.message}`);
    });
    return this.connection;
  }

  /**
   * Fire-and-forget publish of one {@link AgentEvent} for `agentId`.
   * No-op when Redis is not configured.
   */
  publish(agentId: UUID, event: AgentEvent): void {
    const connection = this.getConnection();
    if (!connection) return;
    void connection
      .publish(agentEventsChannel(agentId), JSON.stringify(event))
      .catch((err: unknown) => {
        this.logger.warn(
          `Failed to publish ${event.kind} for agent ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  /** Closes the shared connection on shutdown. */
  async onModuleDestroy(): Promise<void> {
    if (this.connection) {
      await this.connection.quit().catch(() => undefined);
      this.connection = null;
    }
  }
}
