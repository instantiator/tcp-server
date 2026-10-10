import {
  AgentStatus,
  AuditEvent,
  AuditEventType,
  RUN_FAILURE_MESSAGES,
  TcpAgent,
} from '@tcp/shared';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { AgentOrchestrationService } from './agent-orchestration.service';
import { PauseAndResumeService } from './pause-and-resume.service';
import { TaskFailureService } from './task-failure.service';

/** Statuses that mean a loop should be running, or about to run, for the agent. */
const LIVE_STATUSES = [AgentStatus.Running, AgentStatus.Queued];

/** Task and assignment statuses past which nothing should carry on. */
const FINISHED = ['succeeded', 'failed', 'cancelled'];

/**
 * Puts agents right after tcp-server starts: the half of startup recovery
 * that works on agents rather than tasks (see `TaskRecoveryService`).
 *
 * 1. **Stranded agents** — `running` or `queued`, with no job in the queue —
 *    were cut off by a crash, or by a failure that couldn't be saved. Each is
 *    paused for a restart, so step 2 carries it on from its checkpoint. It is
 *    failed instead when its task has already ended, or when an earlier boot
 *    already recovered it: an agent that keeps stranding would otherwise be
 *    resumed on every boot.
 * 2. **Restart pauses** — left by a restart drain, or by step 1 — are resumed.
 *
 * ponytail: runs on tcp-server's boot only. An agent stranded by a tcp-agent
 * restart while tcp-server stays up is left to BullMQ's stall handling; run
 * step 1 on a timer if that is seen.
 */
@Injectable()
export class AgentRecoveryService {
  private readonly logger = new Logger(AgentRecoveryService.name);

  constructor(
    @InjectRepository(TcpAgent)
    private readonly agentRepo: Repository<TcpAgent>,
    @InjectRepository(AuditEvent)
    private readonly auditRepo: Repository<AuditEvent>,
    private readonly orchestration: AgentOrchestrationService,
    private readonly pauseResume: PauseAndResumeService,
    private readonly failures: TaskFailureService,
    private readonly audit: AuditService,
  ) {}

  /** Repairs stranded agents, then resumes everything paused for a restart. */
  async recover(): Promise<void> {
    await this.repairStranded();
    await this.resumeRestartPauses();
  }

  /** Step 1: every `running`/`queued` agent with no job is repaired or failed. */
  private async repairStranded(): Promise<void> {
    const candidates = await this.agentRepo.find({
      where: { status: In(LIVE_STATUSES) },
      relations: { assignment: { task: true }, role: true },
    });
    if (candidates.length === 0) return;

    let withJobs: Set<string>;
    try {
      withJobs = await this.orchestration.agentIdsWithJobs();
    } catch (err) {
      // Never fail an agent for want of seeing its job: leave them all.
      this.logger.error(
        `Couldn't read the agent queue, so stranded agents weren't checked: ${errorText(err)}`,
      );
      return;
    }

    for (const agent of candidates) {
      if (withJobs.has(agent.id)) continue;
      try {
        if (await this.shouldFail(agent)) await this.fail(agent);
        else await this.pauseForRestart(agent);
      } catch (err) {
        this.logger.error(
          `Recovering stranded agent ${agent.id} failed: ${errorText(err)}`,
        );
      }
    }
  }

  /** True when the agent's work has ended, or it was already recovered once. */
  private async shouldFail(agent: TcpAgent): Promise<boolean> {
    const task = agent.assignment?.task;
    if (task && FINISHED.includes(task.status)) return true;
    if (agent.assignment && FINISHED.includes(agent.assignment.status)) {
      return true;
    }
    const changes = await this.auditRepo.find({
      where: { agentId: agent.id, eventType: AuditEventType.StateChange },
    });
    return changes.some((event) => event.payload['recovered'] === true);
  }

  /** Pauses a stranded agent for a restart, marking it recovered. */
  private async pauseForRestart(agent: TcpAgent): Promise<void> {
    const claimed = await this.agentRepo.update(
      { id: agent.id, status: agent.status },
      {
        status: AgentStatus.Paused,
        pauseReason: 'restart',
        pausedAt: new Date(),
      },
    );
    if (!claimed.affected) return;
    await this.audit.record(
      agent.companyId,
      agent.role?.name ?? 'agent',
      agent.id,
      AuditEventType.StateChange,
      {
        entity: 'agent',
        newStatus: AgentStatus.Paused,
        reason: 'restart',
        recovered: true,
      },
    );
    this.logger.warn(
      `Agent ${agent.id} was stranded ${agent.status} with no job — paused to carry on after the restart`,
    );
  }

  /** Fails a stranded agent that mustn't carry on, and its task with it. */
  private async fail(agent: TcpAgent): Promise<void> {
    const claimed = await this.agentRepo.update(
      { id: agent.id, status: agent.status },
      { status: AgentStatus.Failed },
    );
    if (!claimed.affected) return;
    const reason = RUN_FAILURE_MESSAGES.interrupted({});
    await this.pauseResume.failAgent(agent.id, reason);
    await this.failures.handleAgentFailed(agent.id, reason);
    this.logger.warn(
      `Agent ${agent.id} was stranded ${agent.status} and can't carry on — failed`,
    );
  }

  /**
   * Step 2: resumes every agent paused for a restart. A task a user paused
   * refuses (409), and is left for its own resume.
   */
  private async resumeRestartPauses(): Promise<void> {
    const paused = await this.agentRepo.find({
      where: { status: AgentStatus.Paused, pauseReason: 'restart' },
    });
    for (const agent of paused) {
      try {
        await this.orchestration.resumeAgent(agent.id, undefined, {
          lifts: ['restart'],
        });
        this.logger.log(`Resumed agent ${agent.id} after the restart`);
      } catch (err) {
        this.logger.warn(
          `Agent ${agent.id} stays paused after the restart: ${errorText(err)}`,
        );
      }
    }
  }
}

/** A thrown value as readable text. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
