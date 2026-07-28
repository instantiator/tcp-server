import {
  SHUTDOWN_COMMAND_CHANNEL,
  SHUTDOWN_STATUS_CHANNEL,
  ShutdownCommand,
} from '@tcp/shared';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { AgentRegistryService } from '../registry/agent-registry.service';

/** The reason recorded against runs stopped by a forced shutdown. */
const FORCED_SHUTDOWN_REASON = 'forced shutdown';

/**
 * tcp-agent's half of the shutdown protocol: listens for drain commands from
 * tcp-server, and reports how many agent loops are still in flight.
 *
 * The report is the point. tcp-server pauses agents by writing to their rows,
 * but reading those writes back would only tell it what it already asked for —
 * an agent mid-LLM-call is still burning tokens long after its row says
 * `paused`. This service answers from the in-memory
 * {@link AgentRegistryService}, which is the only place that knows.
 *
 * Both drain modes stop the worker taking new jobs; a forced drain also aborts
 * the in-flight LLM calls, wasting whatever those calls have cost so far.
 */
@Injectable()
export class ShutdownListenerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ShutdownListenerService.name);
  private subscriber: Redis | null = null;
  private publisher: Redis | null = null;
  private worker: Worker | null = null;
  private draining = false;

  constructor(
    private readonly config: ConfigService,
    private readonly registry: AgentRegistryService,
  ) {}

  /**
   * Opens the Redis connections and starts listening.
   * A missing `REDIS_URL` (unit tests) leaves the service inert.
   */
  async onModuleInit(): Promise<void> {
    const url = this.config.get<string>('REDIS_URL');
    if (!url) return;

    this.publisher = new Redis(url);
    this.publisher.on('error', (err: Error) => {
      this.logger.warn(`Shutdown publisher connection error: ${err.message}`);
    });

    this.subscriber = new Redis(url);
    this.subscriber.on('error', (err: Error) => {
      this.logger.warn(`Shutdown subscriber connection error: ${err.message}`);
    });
    this.subscriber.on('message', (channel: string, message: string) => {
      if (channel === SHUTDOWN_COMMAND_CHANNEL) void this.handle(message);
    });
    await this.subscriber.subscribe(SHUTDOWN_COMMAND_CHANNEL);
    this.logger.log('Listening for shutdown commands');
  }

  /** Closes both Redis connections on teardown. */
  async onModuleDestroy(): Promise<void> {
    await this.publisher?.quit().catch(() => undefined);
    await this.subscriber?.quit().catch(() => undefined);
    this.publisher = null;
    this.subscriber = null;
  }

  /**
   * Hands over the BullMQ worker to pause and resume.
   *
   * Passed in by {@link AgentWorkerService} once it has started, rather than
   * injected, because the worker already depends on this service to report
   * each finished job.
   */
  bindWorker(worker: Worker): void {
    this.worker = worker;
  }

  /**
   * Tells tcp-server how many loops are still running.
   *
   * Only reports during a drain: outside one there is nobody waiting on the
   * answer, and the server discards any report predating the current drain.
   */
  reportActive(): void {
    if (!this.draining || !this.publisher) return;
    const activeAgents = this.registry.activeCount;
    void this.publisher
      .publish(SHUTDOWN_STATUS_CHANNEL, JSON.stringify({ activeAgents }))
      .catch((err: unknown) => {
        // Never silent: an unreported quiescence leaves the operator's drain
        // hanging until it times out, with no clue why.
        this.logger.error(
          `Failed to report ${activeAgents} active loop(s) to tcp-server: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  /** Applies one drain command, then reports the resulting in-flight count. */
  private async handle(message: string): Promise<void> {
    let command: ShutdownCommand;
    try {
      command = JSON.parse(message) as ShutdownCommand;
    } catch (err) {
      this.logger.warn(
        `Ignoring malformed shutdown command: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    switch (command.action) {
      case 'drain':
        this.draining = true;
        await this.stopTakingJobs();
        this.logger.warn(
          `Draining: ${this.registry.activeCount} loop(s) will stop at their next boundary`,
        );
        break;
      case 'force':
        this.draining = true;
        await this.stopTakingJobs();
        this.logger.warn(
          `Forced shutdown: aborting ${this.registry.abortAll(FORCED_SHUTDOWN_REASON)} in-flight loop(s)`,
        );
        break;
      case 'cancel':
        this.draining = false;
        // Unlike pause(), BullMQ's resume() is synchronous.
        this.worker?.resume();
        this.logger.warn('Shutdown cancelled — taking jobs again');
        return;
    }

    this.reportActive();
  }

  /**
   * Stops the worker picking up further jobs, leaving in-flight ones running.
   *
   * Deliberately `pause()` rather than a forced `close(true)`: closing would
   * abandon jobs mid-write and could not be undone, so a cancelled drain could
   * never hand the worker back. Forced mode stops the actual LLM work through
   * the registry's abort signals instead, which is both more precise and
   * reversible.
   */
  private async stopTakingJobs(): Promise<void> {
    if (!this.worker) {
      this.logger.warn('No worker bound yet — cannot stop taking jobs');
      return;
    }
    await this.worker.pause();
  }
}
