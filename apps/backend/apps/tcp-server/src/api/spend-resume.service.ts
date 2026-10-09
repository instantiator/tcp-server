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
import {
  AgentOrchestrationService,
  type ResumeOptions,
} from './agent-orchestration.service';
import { SystemShutdownService } from './system-shutdown.service';
import { TaskStateService } from './task-state.service';

/** How often the sweep looks for caps whose window has ended. */
const RESET_SWEEP_INTERVAL_MS = 60_000;

/** Pauses an explicit resume lifts: nothing else is waiting on them. */
const EXPLICITLY_RESUMABLE: PauseReason[] = [
  'spend_cap',
  'shutdown',
  'rate_limited',
  'manual',
];

/**
 * What a task resume lifts: the explicit pauses, plus waits on a reply or a
 * consultation. A reply that arrived while the task was paused stayed
 * undelivered, so its agent resumes now; one still waiting on an answer
 * stays paused (`resumeAgent` counts what is outstanding).
 */
const TASK_RESUME_LIFTS: PauseReason[] = [
  ...EXPLICITLY_RESUMABLE,
  'user_input',
  'consultation',
];

/**
 * Resumes the work spend caps paused: automatically when a cap resets or is
 * dismissed, and on an explicit task or company resume — which also lifts a
 * user's pause, a shutdown or a rate limit. An explicit resume made while a
 * cap is reached exempts its tasks from caps until they end, so they aren't
 * paused again on their next LLM call — the user chose to spend.
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
    private readonly taskState: TaskStateService,
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
   * Resumes a task: lifts a user's pause, then resumes its agents paused by
   * that, a cap, a shutdown or a rate limit, plus any whose awaited reply
   * arrived meanwhile. Exempts the task from caps only if one is reached
   * now — the same rule as Start, so resuming a user's pause doesn't quietly
   * switch off spend protection.
   */
  async resumeTask(taskId: UUID): Promise<ResumeResult> {
    this.shutdown.assertAccepting();
    const task = await this.taskRepo.findOneBy({ id: taskId });
    if (!task) throw new NotFoundException(`Task ${taskId} not found`);
    // Exempt first: a resumed agent must not meet the gate before this lands.
    await this.exemptIfCapped(taskId);
    if (task.pausedAt) {
      await this.taskRepo.update(taskId, {
        pausedAt: () => 'NULL',
        pausedBy: null,
      });
      await this.taskState.recordTaskState(
        { ...task, pausedAt: undefined, pausedBy: null },
        task.status,
        'resumed by a user',
      );
    }
    const agents = await this.agentRepo.find({
      where: {
        status: AgentStatus.Paused,
        pauseReason: In(TASK_RESUME_LIFTS),
        assignment: { taskId },
      },
    });
    return {
      resumed: await this.resumeEach(agents, {
        lifts: TASK_RESUME_LIFTS,
        taskResume: true,
      }),
    };
  }

  /**
   * Resumes every task in a company that has agents paused by a cap, a
   * shutdown or a rate limit. A task a user paused is left for its own
   * resume: resuming a whole company shouldn't undo one person's choice.
   */
  async resumeCompany(companyId: UUID): Promise<ResumeResult> {
    this.shutdown.assertAccepting();
    const lifts = EXPLICITLY_RESUMABLE.filter((reason) => reason !== 'manual');
    const agents = (
      await this.agentRepo.find({
        where: {
          companyId,
          status: AgentStatus.Paused,
          pauseReason: In(lifts),
        },
        relations: { assignment: { task: true } },
      })
    ).filter((agent) => !agent.assignment?.task?.pausedAt);
    const taskIds = new Set(
      agents.flatMap((agent) =>
        agent.assignment?.taskId ? [agent.assignment.taskId] : [],
      ),
    );
    for (const taskId of taskIds) await this.exemptIfCapped(taskId);
    return { resumed: await this.resumeEach(agents, { lifts }) };
  }

  /**
   * Resumes every agent a spend cap paused. Ones whose provider is still
   * capped simply pause again at their first gate check, spending nothing.
   */
  private async resumeCapPaused(): Promise<void> {
    if (this.shutdown.isShuttingDown) return;
    const agents = await this.agentRepo.find({
      where: { status: AgentStatus.Paused, pauseReason: 'spend_cap' },
      relations: { assignment: { task: true } },
    });
    // A task a user paused waits for its own resume.
    await this.resumeEach(
      agents.filter((agent) => !agent.assignment?.task?.pausedAt),
      { lifts: ['spend_cap'] },
    );
  }

  /** Queues a resume for each agent; one failure doesn't stop the rest. */
  private async resumeEach(
    agents: TcpAgent[],
    options: ResumeOptions,
  ): Promise<number> {
    let resumed = 0;
    for (const agent of agents) {
      try {
        await this.orchestration.resumeAgent(agent.id, undefined, options);
        resumed++;
      } catch (err) {
        this.logger.warn(`Could not resume agent ${agent.id}: ${String(err)}`);
      }
    }
    return resumed;
  }
}
