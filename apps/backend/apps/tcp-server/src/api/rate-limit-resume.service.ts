import { AgentStatus, TcpAgent } from '@tcp/shared';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { AgentOrchestrationService } from './agent-orchestration.service';
import { SystemShutdownService } from './system-shutdown.service';

/**
 * How often the sweep looks for rate-limited agents that are due. Short
 * hints (60 s or less) are retried inside LangChain before an agent ever
 * pauses, so a pause is always for longer than this.
 */
const RATE_LIMIT_SWEEP_INTERVAL_MS = 15_000;

/**
 * Resumes agents a provider rate-limited once their `resumeAfter` passes.
 * tcp-agent sets that time (the provider's hint, or the backoff), or leaves
 * it null when `RATE_LIMIT_AUTO_RESUME` is off — such an agent waits for an
 * explicit task or company resume ({@link SpendResumeService}).
 *
 * Unlike the spend-cap sweep this always runs: any provider can rate-limit.
 */
@Injectable()
export class RateLimitResumeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RateLimitResumeService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly orchestration: AgentOrchestrationService,
    private readonly shutdown: SystemShutdownService,
    @InjectRepository(TcpAgent)
    private readonly agentRepo: Repository<TcpAgent>,
  ) {}

  /** Starts the sweep: an in-process timer, as the spend-cap sweep uses. */
  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.sweep();
    }, RATE_LIMIT_SWEEP_INTERVAL_MS).unref();
  }

  /** Stops the sweep. */
  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /**
   * Resumes every rate-limited agent that is due. One that the provider
   * still refuses simply pauses again with a later time.
   */
  async sweep(): Promise<void> {
    if (this.shutdown.isShuttingDown) return;
    try {
      const due = await this.agentRepo.find({
        where: {
          status: AgentStatus.Paused,
          pauseReason: 'rate_limited',
          resumeAfter: LessThanOrEqual(new Date()),
        },
        relations: { assignment: { task: true } },
      });
      // A task a user paused waits for its own resume.
      for (const agent of due.filter((a) => !a.assignment?.task?.pausedAt)) {
        try {
          await this.orchestration.resumeAgent(agent.id, undefined, {
            lifts: ['rate_limited'],
          });
        } catch (err) {
          this.logger.warn(
            `Could not resume rate-limited agent ${agent.id}: ${String(err)}`,
          );
        }
      }
    } catch (err) {
      this.logger.error(`Rate-limit resume sweep failed: ${String(err)}`);
    }
  }
}
