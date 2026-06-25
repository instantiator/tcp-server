import { AgentStatus, LcpAgent } from '@lcp/shared';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { UUID } from 'crypto';
import { DbService } from '../db/db.service';
import { LcpAgentTemplate } from '../templates/LcpAgentTemplate';

/** Payload dispatched to the `agent-jobs` BullMQ queue. */
interface AgentJob {
  agentId: string;
  type: 'start' | 'resume';
  /** User reply or consultation result injected as the first message on resume. */
  replyContent?: string;
}

/**
 * Creates and resumes agents by enqueuing jobs to the `agent-jobs` BullMQ queue,
 * which lcp-agent workers consume.
 *
 * The database record is created (or updated) here so callers can track
 * the agent immediately, without waiting for lcp-agent to pick up the job.
 */
@Injectable()
export class AgentOrchestrationService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AgentOrchestrationService.name);
  private queue!: Queue<AgentJob>;

  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService,
  ) {}

  /** Connects to the Redis-backed BullMQ queue on startup. */
  onModuleInit(): void {
    const url = this.config.getOrThrow<string>('REDIS_URL');
    this.queue = new Queue<AgentJob>('agent-jobs', { connection: { url } });
    this.logger.log('Connected to agent-jobs queue');
  }

  /** Closes the queue connection gracefully on shutdown. */
  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }

  /**
   * Creates a new {@link LcpAgent} record and dispatches a `start` job
   * to lcp-agent via the BullMQ queue.
   */
  async startAgent(template: LcpAgentTemplate): Promise<LcpAgent> {
    const agent = await this.db.createAgent(template);
    await this.queue.add('start', { agentId: agent.id, type: 'start' });
    this.logger.log(`Dispatched start job for agent ${agent.id}`);
    return agent;
  }

  /**
   * Validates that the agent exists and is in a resumable state, then
   * dispatches a `resume` job.
   *
   * @param replyContent - Optional content injected as the first HumanMessage
   *   on resume (user reply or consultation result).
   * @throws if the agent does not exist or is not in a resumable state
   */
  async resumeAgent(agentId: UUID, replyContent?: string): Promise<LcpAgent> {
    const agent = await this.db.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }
    const resumable: AgentStatus[] = [
      AgentStatus.Idle,
      AgentStatus.Paused,
      AgentStatus.Failed,
    ];
    if (!resumable.includes(agent.status)) {
      throw new Error(
        `Agent ${agentId} cannot be resumed from status '${agent.status}'`,
      );
    }
    await this.queue.add('resume', {
      agentId: agent.id,
      type: 'resume',
      replyContent,
    });
    this.logger.log(`Dispatched resume job for agent ${agent.id}`);
    return agent;
  }
}
