import { AgentEvent, agentEventsChannel } from '@lcp/shared';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Observable, Subject } from 'rxjs';

export type { AgentEvent, AgentEventKind } from '@lcp/shared';

/** Channel prefix, derived from the shared helper so the two never drift. */
const CHANNEL_PREFIX = agentEventsChannel('');

/**
 * Per-agent event bus feeding the `GET /api/agent/:id/events` SSE endpoint.
 *
 * Each agent gets its own {@link Subject}. Two producers feed it:
 * - **In-process** callers (chat, context compaction, pause/resume) push
 *   directly via {@link AgentEventService.emit}.
 * - The **out-of-process** lcp-agent worker publishes to the per-agent Redis
 *   channel; this service subscribes to that channel while at least one SSE
 *   client is observing the agent and relays each message onto the subject.
 *
 * The Redis subscription is reference-counted per agent — opened when the
 * first observer attaches and closed when the last detaches — over a single
 * shared subscriber connection. When `REDIS_URL` is unset (e.g. unit tests)
 * the relay is disabled and the bus is purely in-memory.
 */
@Injectable()
export class AgentEventService implements OnModuleDestroy {
  private readonly logger = new Logger(AgentEventService.name);
  private readonly subjects = new Map<string, Subject<AgentEvent>>();
  private readonly refCounts = new Map<string, number>();
  private subscriber: Redis | null = null;
  private subscriberDisabled = false;

  constructor(private readonly config: ConfigService) {}

  /** Returns (or creates) the {@link Subject} for the given agent ID. */
  private getOrCreate(agentId: string): Subject<AgentEvent> {
    let subject = this.subjects.get(agentId);
    if (!subject) {
      subject = new Subject<AgentEvent>();
      this.subjects.set(agentId, subject);
    }
    return subject;
  }

  /**
   * Emits an {@link AgentEvent} to all current SSE subscribers for `agentId`.
   * No-op when no subscribers are connected. Used by in-process producers.
   */
  emit(agentId: string, event: AgentEvent): void {
    this.subjects.get(agentId)?.next(event);
  }

  /**
   * Returns an {@link Observable} of events for `agentId`. Subscribing attaches
   * to (and, if it is the first subscriber, opens the Redis relay for) the
   * agent; unsubscribing releases it. Subscribe to this from an SSE endpoint.
   */
  observe(agentId: string): Observable<AgentEvent> {
    const subject = this.getOrCreate(agentId);
    return new Observable<AgentEvent>((subscriber) => {
      this.retain(agentId);
      const inner = subject.subscribe(subscriber);
      return () => {
        inner.unsubscribe();
        this.release(agentId);
      };
    });
  }

  /** Increments the observer refcount, subscribing the Redis channel on 0→1. */
  private retain(agentId: string): void {
    const next = (this.refCounts.get(agentId) ?? 0) + 1;
    this.refCounts.set(agentId, next);
    if (next === 1) this.subscribeChannel(agentId);
  }

  /** Decrements the observer refcount, unsubscribing the channel on 1→0. */
  private release(agentId: string): void {
    const current = this.refCounts.get(agentId) ?? 0;
    if (current <= 1) {
      this.refCounts.delete(agentId);
      this.unsubscribeChannel(agentId);
    } else {
      this.refCounts.set(agentId, current - 1);
    }
  }

  /**
   * Returns the shared subscriber connection, opening it on first use.
   * Returns null (and stays disabled) when `REDIS_URL` is not configured.
   */
  private getSubscriber(): Redis | null {
    if (this.subscriberDisabled) return null;
    if (this.subscriber) return this.subscriber;

    const url = this.config.get<string>('REDIS_URL');
    if (!url) {
      this.subscriberDisabled = true;
      return null;
    }

    this.subscriber = new Redis(url);
    // Swallow connection errors — the relay is best-effort and an unhandled
    // 'error' would otherwise crash the process.
    this.subscriber.on('error', (err: Error) => {
      this.logger.warn(`Event relay connection error: ${err.message}`);
    });
    this.subscriber.on('message', (channel: string, message: string) => {
      this.relay(channel, message);
    });
    return this.subscriber;
  }

  /** Subscribes the shared connection to one agent's channel. */
  private subscribeChannel(agentId: string): void {
    const subscriber = this.getSubscriber();
    if (!subscriber) return;
    void subscriber
      .subscribe(agentEventsChannel(agentId))
      .catch((err: unknown) => {
        this.logger.warn(
          `Failed to subscribe to events for agent ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  /** Unsubscribes the shared connection from one agent's channel. */
  private unsubscribeChannel(agentId: string): void {
    if (!this.subscriber) return;
    void this.subscriber
      .unsubscribe(agentEventsChannel(agentId))
      .catch(() => undefined);
  }

  /** Parses a relayed Redis message and pushes it onto the agent's subject. */
  private relay(channel: string, message: string): void {
    if (!channel.startsWith(CHANNEL_PREFIX)) return;
    const agentId = channel.slice(CHANNEL_PREFIX.length);
    try {
      const event = JSON.parse(message) as AgentEvent;
      this.subjects.get(agentId)?.next(event);
    } catch (err) {
      this.logger.warn(
        `Ignoring malformed agent event on ${channel}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Completes and removes the subject for `agentId`, and releases any Redis
   * subscription. Call this when an agent is deleted to free resources.
   */
  cleanup(agentId: string): void {
    const subject = this.subjects.get(agentId);
    if (subject) {
      subject.complete();
      this.subjects.delete(agentId);
    }
    this.refCounts.delete(agentId);
    this.unsubscribeChannel(agentId);
  }

  /** Completes all open subjects and closes the subscriber on teardown. */
  async onModuleDestroy(): Promise<void> {
    for (const subject of this.subjects.values()) {
      subject.complete();
    }
    this.subjects.clear();
    this.refCounts.clear();
    if (this.subscriber) {
      await this.subscriber.quit().catch(() => undefined);
      this.subscriber = null;
    }
  }
}
