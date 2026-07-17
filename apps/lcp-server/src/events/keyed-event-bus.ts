import { Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Observable, Subject } from 'rxjs';

/**
 * Generic per-key event bus backing an SSE endpoint family (company/task
 * events — see {@link CompanyEventService}/{@link TaskEventService}).
 * Mirrors {@link AgentEventService}'s shape (per-key `Subject`, ref-counted
 * Redis relay, disabled when `REDIS_URL` is unset), but with one difference:
 * every producer of these events lives in-process within lcp-server (unlike
 * the agent bus, which relays events published by the separate lcp-agent
 * worker process), so `emit` publishes to Redis and lets the channel
 * subscription deliver the event back to local observers — rather than
 * pushing to the local `Subject` directly — which avoids double-delivery on
 * an instance that both emits and observes the same key. When Redis isn't
 * configured, `emit` falls back to a direct local push (pure in-memory, e.g.
 * unit tests), since there is no relay to round-trip through.
 */
export class KeyedEventBus<E> implements OnModuleDestroy {
  private readonly logger: Logger;
  private readonly subjects = new Map<string, Subject<E>>();
  private readonly refCounts = new Map<string, number>();
  private subscriber: Redis | null = null;
  private publisher: Redis | null = null;
  private redisDisabled = false;

  constructor(
    private readonly config: ConfigService,
    private readonly channelFor: (key: string) => string,
    private readonly channelPrefix: string,
    loggerName: string,
  ) {
    this.logger = new Logger(loggerName);
  }

  /** Returns (or creates) the {@link Subject} for the given key. */
  private getOrCreate(key: string): Subject<E> {
    let subject = this.subjects.get(key);
    if (!subject) {
      subject = new Subject<E>();
      this.subjects.set(key, subject);
    }
    return subject;
  }

  /**
   * Publishes an event for `key`. When Redis is configured, delivery is via
   * publish + the relay below (so it reaches every instance, including this
   * one, exactly once); otherwise pushes directly to the local `Subject`.
   */
  emit(key: string, event: E): void {
    const publisher = this.getPublisher();
    if (!publisher) {
      this.subjects.get(key)?.next(event);
      return;
    }
    void publisher
      .publish(this.channelFor(key), JSON.stringify(event))
      .catch((err: unknown) => {
        this.logger.warn(
          `Failed to publish event on ${this.channelFor(key)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  /**
   * Returns an {@link Observable} of events for `key`. Subscribing attaches
   * to (and, if it is the first subscriber, opens the Redis relay for) the
   * key; unsubscribing releases it. Subscribe to this from an SSE endpoint.
   */
  observe(key: string): Observable<E> {
    const subject = this.getOrCreate(key);
    return new Observable<E>((subscriber) => {
      this.retain(key);
      const inner = subject.subscribe(subscriber);
      return () => {
        inner.unsubscribe();
        this.release(key);
      };
    });
  }

  /** Increments the observer refcount, subscribing the Redis channel on 0→1. */
  private retain(key: string): void {
    const next = (this.refCounts.get(key) ?? 0) + 1;
    this.refCounts.set(key, next);
    if (next === 1) this.subscribeChannel(key);
  }

  /** Decrements the observer refcount, unsubscribing the channel on 1→0. */
  private release(key: string): void {
    const current = this.refCounts.get(key) ?? 0;
    if (current <= 1) {
      this.refCounts.delete(key);
      this.unsubscribeChannel(key);
    } else {
      this.refCounts.set(key, current - 1);
    }
  }

  /**
   * Returns the shared publisher connection, opening it on first use.
   * Returns null (and stays disabled) when `REDIS_URL` is not configured.
   */
  private getPublisher(): Redis | null {
    if (this.redisDisabled) return null;
    if (this.publisher) return this.publisher;

    const url = this.config.get<string>('REDIS_URL');
    if (!url) {
      this.redisDisabled = true;
      return null;
    }

    this.publisher = new Redis(url);
    this.publisher.on('error', (err: Error) => {
      this.logger.warn(`Event publisher connection error: ${err.message}`);
    });
    return this.publisher;
  }

  /**
   * Returns the shared subscriber connection, opening it on first use.
   * Returns null when Redis is disabled (implies `getPublisher` was tried).
   */
  private getSubscriber(): Redis | null {
    if (this.redisDisabled) return null;
    if (this.subscriber) return this.subscriber;

    const url = this.config.get<string>('REDIS_URL');
    if (!url) {
      this.redisDisabled = true;
      return null;
    }

    this.subscriber = new Redis(url);
    this.subscriber.on('error', (err: Error) => {
      this.logger.warn(`Event relay connection error: ${err.message}`);
    });
    this.subscriber.on('message', (channel: string, message: string) => {
      this.relay(channel, message);
    });
    return this.subscriber;
  }

  /** Subscribes the shared connection to one key's channel. */
  private subscribeChannel(key: string): void {
    const subscriber = this.getSubscriber();
    if (!subscriber) return;
    void subscriber.subscribe(this.channelFor(key)).catch((err: unknown) => {
      this.logger.warn(
        `Failed to subscribe to events for ${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /** Unsubscribes the shared connection from one key's channel. */
  private unsubscribeChannel(key: string): void {
    if (!this.subscriber) return;
    void this.subscriber
      .unsubscribe(this.channelFor(key))
      .catch(() => undefined);
  }

  /** Parses a relayed Redis message and pushes it onto the key's subject. */
  private relay(channel: string, message: string): void {
    if (!channel.startsWith(this.channelPrefix)) return;
    const key = channel.slice(this.channelPrefix.length);
    try {
      const event = JSON.parse(message) as E;
      this.subjects.get(key)?.next(event);
    } catch (err) {
      this.logger.warn(
        `Ignoring malformed event on ${channel}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Completes all open subjects and closes the Redis connections on teardown. */
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
    if (this.publisher) {
      await this.publisher.quit().catch(() => undefined);
      this.publisher = null;
    }
  }
}
