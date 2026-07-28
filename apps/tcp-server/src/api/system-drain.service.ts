import {
  AgentStatus,
  AuditEventType,
  SHUTDOWN_COMMAND_CHANNEL,
  SHUTDOWN_STATUS_CHANNEL,
  ShutdownAction,
  ShutdownStatusReport,
  TcpAgent,
} from '@tcp/shared';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import {
  ShutdownState,
  SystemShutdownService,
} from './system-shutdown.service';

/** A point-in-time answer to "is it safe to halt the stack yet?". */
export interface ShutdownStatus {
  state: ShutdownState;
  /** True when the current drain aborts in-flight LLM calls rather than waiting. */
  forced: boolean;
  /** Agent loops still to come to rest. Zero, with state `quiesced`, means safe to halt. */
  agentsRunning: number;
}

/**
 * Executes a shutdown drain: brings every running agent to rest and reports
 * when the system has actually quiesced.
 *
 * Draining works in two halves, because neither alone is trustworthy:
 *
 * 1. **Requesting the stop** — every `Running` agent is marked
 *    {@link AgentStatus.Paused} with reason `shutdown`. The agent loop's
 *    existing terminal-status check picks this up at its next iteration
 *    boundary (after the LLM has answered) and exits with its LangGraph
 *    checkpoint intact, so no spent tokens are wasted.
 * 2. **Confirming the stop** — tcp-agent reports its real in-memory count of
 *    running loops back over {@link SHUTDOWN_STATUS_CHANNEL}. Without this,
 *    the drain would read its own `Paused` writes back and declare success
 *    while an agent was still mid-LLM-call.
 *
 * A drain that marked nothing needs no confirmation: there was no loop to
 * wait for, so it quiesces on the database count alone and does not depend on
 * tcp-agent being deployed at all.
 */
@Injectable()
export class SystemDrainService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SystemDrainService.name);
  private publisher: Redis | null = null;
  private subscriber: Redis | null = null;

  /** How many agents the current drain marked, i.e. how many stops it must see confirmed. */
  private markedByDrain = 0;
  /** The worker's last reported in-flight count; null until it has reported since the drain began. */
  private lastReportedActive: number | null = null;

  constructor(
    @InjectRepository(TcpAgent)
    private readonly agentRepo: Repository<TcpAgent>,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly shutdown: SystemShutdownService,
  ) {}

  /**
   * Opens the Redis connections and starts listening for worker reports.
   * A missing `REDIS_URL` (unit tests) leaves the service inert: drains still
   * work off the database, they just cannot be confirmed by a worker.
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
      if (channel === SHUTDOWN_STATUS_CHANNEL) this.receiveReport(message);
    });
    await this.subscriber.subscribe(SHUTDOWN_STATUS_CHANNEL);
  }

  /** Closes both Redis connections on teardown. */
  async onModuleDestroy(): Promise<void> {
    await this.publisher?.quit().catch(() => undefined);
    await this.subscriber?.quit().catch(() => undefined);
    this.publisher = null;
    this.subscriber = null;
  }

  /**
   * Begins (or escalates) a drain and returns the resulting snapshot.
   *
   * Idempotent: re-requesting a graceful drain that is already running marks
   * nothing further and simply reports progress.
   */
  async begin(force: boolean): Promise<ShutdownStatus> {
    // Escalating a drain that is already running continues the same episode:
    // its counters carry over, so agents already waiting to stop still count.
    const startingFresh = !this.shutdown.isShuttingDown;
    const changed = this.shutdown.begin(force);
    if (changed) {
      if (startingFresh) {
        this.markedByDrain = 0;
        this.lastReportedActive = null;
      }
      this.markedByDrain += await this.pauseRunningAgents();
      await this.publish(force ? 'force' : 'drain');
    }
    return this.status();
  }

  /**
   * Cancels a drain so the system accepts work again, and tells the workers to
   * start taking jobs again.
   *
   * Agents the drain paused stay paused — resuming them here would be an
   * unrequested burst of token spend, so a user resumes them explicitly.
   *
   * @returns The resulting snapshot, or null when no drain was in progress.
   */
  async cancel(): Promise<ShutdownStatus | null> {
    if (!this.shutdown.cancel()) return null;
    this.markedByDrain = 0;
    this.lastReportedActive = null;
    await this.publish('cancel');
    return this.status();
  }

  /**
   * Reports where the drain has got to, re-evaluating quiescence first so that
   * polling this endpoint is enough to observe the transition.
   *
   * Cheap enough to poll every second: one indexed count query.
   */
  async status(): Promise<ShutdownStatus> {
    const running = await this.countRunningAgents();
    this.evaluateQuiescence(running);
    return {
      state: this.shutdown.currentState,
      forced: this.shutdown.isForced,
      agentsRunning: this.remainingAgents(running),
    };
  }

  /**
   * Marks every currently `Running` agent as paused for shutdown, recording a
   * `state_change` for each so anything watching sees why it stopped.
   *
   * @returns How many agents were marked.
   */
  private async pauseRunningAgents(): Promise<number> {
    const running = await this.agentRepo.find({
      where: { status: AgentStatus.Running },
      relations: { role: true },
    });
    if (running.length === 0) return 0;

    const pausedAt = new Date();
    for (const agent of running) {
      await this.agentRepo.update(agent.id, {
        status: AgentStatus.Paused,
        pausedAt,
        pauseReason: 'shutdown',
      });
      await this.audit.record(
        agent.companyId,
        agent.role?.name ?? 'agent',
        agent.id,
        AuditEventType.StateChange,
        {
          entity: 'agent',
          newStatus: AgentStatus.Paused,
          reason: 'shutdown',
        },
      );
    }
    this.logger.warn(`Drain paused ${running.length} running agent(s)`);
    return running.length;
  }

  /** Counts agents the database believes are actively running a loop. */
  private countRunningAgents(): Promise<number> {
    return this.agentRepo.count({ where: { status: AgentStatus.Running } });
  }

  /**
   * Promotes the drain to `quiesced` once nothing is left running.
   *
   * A drain that marked agents must additionally have seen tcp-agent report
   * zero in-flight loops — the paused rows are this service's own writes, so
   * believing them alone would report success while an LLM call was still
   * running.
   */
  private evaluateQuiescence(running: number): void {
    if (this.shutdown.currentState !== 'draining') return;
    if (running > 0) return;
    if (this.markedByDrain > 0 && this.lastReportedActive !== 0) return;
    this.shutdown.markQuiesced();
  }

  /**
   * How many agent loops are still to stop: the worker's own count once it has
   * reported, otherwise the number this drain marked. Reconciled against the
   * database count, which catches a loop that started after the marking pass.
   */
  private remainingAgents(running: number): number {
    if (!this.shutdown.isShuttingDown) return running;
    return Math.max(running, this.lastReportedActive ?? this.markedByDrain);
  }

  /** Broadcasts a drain instruction to every tcp-agent worker. */
  private async publish(action: ShutdownAction): Promise<void> {
    if (!this.publisher) return;
    try {
      await this.publisher.publish(
        SHUTDOWN_COMMAND_CHANNEL,
        JSON.stringify({ action }),
      );
    } catch (err) {
      // Never silent: a drain whose workers were not told is a drain that will
      // sit at "draining" until it times out, and the operator needs to know why.
      this.logger.error(
        `Failed to broadcast '${action}' to agent workers: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Records a worker's in-flight count, then re-checks whether that quiesced the system. */
  private receiveReport(message: string): void {
    let report: ShutdownStatusReport;
    try {
      report = JSON.parse(message) as ShutdownStatusReport;
    } catch (err) {
      this.logger.warn(
        `Ignoring malformed shutdown report: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    this.lastReportedActive = report.activeAgents;
    this.logger.log(
      `Agent worker reports ${report.activeAgents} loop(s) running`,
    );
    void this.countRunningAgents()
      .then((running) => this.evaluateQuiescence(running))
      .catch((err: unknown) => {
        this.logger.error(
          `Failed to re-check quiescence after a worker report: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }
}
