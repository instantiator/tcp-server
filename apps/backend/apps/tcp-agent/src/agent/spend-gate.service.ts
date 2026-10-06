import {
  AgentStatus,
  AuditClientService,
  AuditEventType,
  SpendCapState,
  TcpAgent,
  TcpTask,
} from '@tcp/shared';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

/**
 * Enforces spend caps inside the agent loop: before every LLM call it reads
 * the provider's `spend_cap_state` row (written by tcp-server) and, when a
 * reached cap applies to this run, pauses the agent with reason `spend_cap`.
 *
 * Pausing here rather than from tcp-server means the agent stops at a clean
 * iteration boundary with its checkpoint intact and spends nothing further —
 * the same exit a drain uses. Calls already in flight finish, so a cap can
 * overshoot by those.
 */
@Injectable()
export class SpendGateService {
  private readonly logger = new Logger(SpendGateService.name);

  constructor(
    @InjectRepository(SpendCapState)
    private readonly stateRepo: Repository<SpendCapState>,
    @InjectRepository(TcpTask)
    private readonly taskRepo: Repository<TcpTask>,
    @InjectRepository(TcpAgent)
    private readonly agentRepo: Repository<TcpAgent>,
    private readonly auditClient: AuditClientService,
  ) {}

  /**
   * Builds one run's `holdSpending` hook.
   *
   * @param isStart - True for a fresh start job. `finish-agents` only holds
   *   back an agent that hasn't made its first LLM call yet; `pause` holds
   *   every call; `finish-tasks` never holds an agent back.
   */
  forRun(
    agent: TcpAgent,
    provider: string,
    isStart: boolean,
  ): () => Promise<boolean> {
    let calledOnce = false;
    return async () => {
      const notYetStarted = isStart && !calledOnce;
      calledOnce = true;
      if (!(await this.applies(agent, provider, notYetStarted))) return false;
      await this.pause(agent, provider);
      return true;
    };
  }

  /** Whether a reached, undismissed cap on `provider` holds this agent back now. */
  private async applies(
    agent: TcpAgent,
    provider: string,
    notYetStarted: boolean,
  ): Promise<boolean> {
    const state = await this.stateRepo.findOneBy({ provider });
    if (!state?.reachedUntil || state.dismissal !== 'none') return false;
    if (new Date(state.reachedUntil).getTime() <= Date.now()) return false;

    const inScope =
      state.action === 'pause' ||
      (state.action === 'finish-agents' && notYetStarted);
    if (!inScope) return false;

    // Read fresh: an explicit start/resume may have exempted the task since
    // this run loaded it.
    const taskId = agent.assignment?.taskId;
    if (!taskId) return true;
    const task = await this.taskRepo.findOneBy({ id: taskId });
    return !task?.spendCapExempt;
  }

  /** Pauses the agent for the cap and records why, as a drain does. */
  private async pause(agent: TcpAgent, provider: string): Promise<void> {
    await this.agentRepo.update(agent.id, {
      status: AgentStatus.Paused,
      pausedAt: new Date(),
      pauseReason: 'spend_cap',
    });
    this.auditClient.record(
      agent.companyId,
      agent.role.name,
      agent.id,
      AuditEventType.StateChange,
      { entity: 'agent', newStatus: AgentStatus.Paused, reason: 'spend_cap' },
    );
    this.logger.warn(`Agent ${agent.id} paused: ${provider} spend cap reached`);
  }
}
