import {
  AgentStatus,
  TcpAgent,
  TcpTask,
  type CapDismissal,
  type PauseReason,
  type ResumeResult,
  type SpendCapState,
} from '@tcp/shared';
import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import { In, Repository } from 'typeorm';
import { SpendCapService } from '../spend/spend-cap.service';
import { AgentOrchestrationService } from './agent-orchestration.service';
import { SystemShutdownService } from './system-shutdown.service';

/** How often the sweep looks for caps whose window has ended. */
const RESET_SWEEP_INTERVAL_MS = 60_000;

/** Pauses an explicit resume lifts: nothing else is waiting on them. */
const EXPLICITLY_RESUMABLE: PauseReason[] = ['spend_cap', 'shutdown'];

/**
 * Resumes the work spend caps paused: automatically when a cap resets or is
 * dismissed, and on an explicit task or company resume. An explicit resume
 * also exempts its tasks from caps until they end, so they aren't paused
 * again on their next LLM call — the user chose to spend.
 *
 * Lives in the API layer because resuming needs the agent queue
 * ({@link AgentOrchestrationService}); cap evaluation itself is
 * {@link SpendCapService}'s.
 */
@Injectable()
export class SpendResumeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SpendResumeService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly caps: SpendCapService,
    private readonly orchestration: AgentOrchestrationService,
    private readonly shutdown: SystemShutdownService,
    @InjectRepository(TcpAgent)
    private readonly agentRepo: Repository<TcpAgent>,
    @InjectRepository(TcpTask)
    private readonly taskRepo: Repository<TcpTask>,
  ) {}

  /** Starts the reset sweep — only when a cap is configured. */
  onModuleInit(): void {
    if (this.caps.cappedProviders.length === 0) return;
    // In-process timer, not a BullMQ repeatable job: see
    // knowledge-reindex.service.ts for why repeatables don't suit shared-Redis
    // test runs.
    this.timer = setInterval(() => {
      void this.sweep();
    }, RESET_SWEEP_INTERVAL_MS).unref();
  }

  /** Stops the reset sweep. */
  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** Clears expired caps and, if any reset, resumes what they paused. */
  async sweep(): Promise<void> {
    try {
      const reset = await this.caps.resetExpired();
      if (reset.length > 0) await this.resumeCapPaused();
    } catch (err) {
      this.logger.error(`Spend cap reset sweep failed: ${String(err)}`);
    }
  }

  /** Lifts a provider's cap and resumes the agents caps paused. */
  async dismissCap(
    provider: string,
    until: Exclude<CapDismissal, 'none'>,
  ): Promise<SpendCapState> {
    const state = await this.caps.dismiss(provider, until);
    await this.resumeCapPaused();
    return state;
  }

  /**
   * Exempts a task being started while any cap is reached — the user asked
   * for it, so its agents shouldn't be paused on their first LLM call.
   */
  async exemptIfCapped(taskId: UUID): Promise<void> {
    if (await this.caps.isAnyReached()) {
      await this.taskRepo.update(taskId, { spendCapExempt: true });
    }
  }

  /**
   * Exempts a task from spend caps until it ends, and resumes its agents
   * paused by a cap or a shutdown.
   */
  async resumeTask(taskId: UUID): Promise<ResumeResult> {
    this.shutdown.assertAccepting();
    const task = await this.taskRepo.findOneBy({ id: taskId });
    if (!task) throw new NotFoundException(`Task ${taskId} not found`);
    // Exempt first: a resumed agent must not meet the gate before this lands.
    await this.taskRepo.update(taskId, { spendCapExempt: true });
    const agents = await this.agentRepo.find({
      where: {
        status: AgentStatus.Paused,
        pauseReason: In(EXPLICITLY_RESUMABLE),
        assignment: { taskId },
      },
    });
    return { resumed: await this.resumeEach(agents) };
  }

  /** Resumes every task in a company that has agents paused by a cap or a shutdown. */
  async resumeCompany(companyId: UUID): Promise<ResumeResult> {
    this.shutdown.assertAccepting();
    const agents = await this.agentRepo.find({
      where: {
        companyId,
        status: AgentStatus.Paused,
        pauseReason: In(EXPLICITLY_RESUMABLE),
      },
      relations: { assignment: true },
    });
    const taskIds = new Set(
      agents.flatMap((agent) =>
        agent.assignment?.taskId ? [agent.assignment.taskId] : [],
      ),
    );
    if (taskIds.size > 0) {
      await this.taskRepo.update(
        { id: In([...taskIds]) },
        {
          spendCapExempt: true,
        },
      );
    }
    return { resumed: await this.resumeEach(agents) };
  }

  /**
   * Resumes every agent a spend cap paused. Ones whose provider is still
   * capped simply pause again at their first gate check, spending nothing.
   */
  private async resumeCapPaused(): Promise<void> {
    if (this.shutdown.isShuttingDown) return;
    const agents = await this.agentRepo.find({
      where: { status: AgentStatus.Paused, pauseReason: 'spend_cap' },
    });
    await this.resumeEach(agents);
  }

  /** Queues a resume for each agent; one failure doesn't stop the rest. */
  private async resumeEach(agents: TcpAgent[]): Promise<number> {
    let resumed = 0;
    for (const agent of agents) {
      try {
        await this.orchestration.resumeAgent(agent.id);
        resumed++;
      } catch (err) {
        this.logger.warn(`Could not resume agent ${agent.id}: ${String(err)}`);
      }
    }
    return resumed;
  }
}
