import {
  AgentStatus,
  assertRedisReachable,
  Conversation,
  ConversationMessage,
  LcpAgent,
  PendingConsultation,
} from '@lcp/shared';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { UUID } from 'crypto';
import { In, MoreThanOrEqual, Repository } from 'typeorm';
import { DbService } from '../db/db.service';
import { AgentEventService } from '../events/agent-event.service';
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
    @InjectRepository(LcpAgent)
    private readonly agentRepo: Repository<LcpAgent>,
    @InjectRepository(PendingConsultation)
    private readonly consultRepo: Repository<PendingConsultation>,
    @InjectRepository(Conversation)
    private readonly convRepo: Repository<Conversation>,
    @InjectRepository(ConversationMessage)
    private readonly msgRepo: Repository<ConversationMessage>,
    private readonly events: AgentEventService,
  ) {}

  /** Connects to the Redis-backed BullMQ queue on startup. */
  async onModuleInit(): Promise<void> {
    const url = this.config.getOrThrow<string>('REDIS_URL');
    // Fail fast if Redis is unreachable: BullMQ would otherwise retry the
    // connection forever, so enqueue calls hang indefinitely instead of
    // erroring. Better to refuse to start with a clear message.
    await assertRedisReachable(url);
    this.queue = new Queue<AgentJob>('agent-jobs', { connection: { url } });
    // BullMQ surfaces Redis connection problems (including a post-close
    // "Connection is closed") as 'error' events; with no listener they become
    // unhandled rejections that can crash unrelated code — e.g. a later e2e
    // suite sharing the process. Mirror the worker: log and swallow.
    this.queue.on('error', (err) => {
      this.logger.warn(`agent-jobs queue error: ${err.message}`);
    });
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
    await this.dispatchStartJob(agent.id);
    return agent;
  }

  /**
   * Creates a new {@link LcpAgent} record WITHOUT dispatching a job yet.
   * Use together with {@link dispatchStartJob} when other records (e.g. a
   * {@link PendingConsultation}) must be committed before the worker can
   * pick up the job — otherwise the worker may complete and call back
   * before those records exist.
   */
  async createAgent(template: LcpAgentTemplate): Promise<LcpAgent> {
    return this.db.createAgent(template);
  }

  /** Dispatches a `start` job for an already-created agent. */
  async dispatchStartJob(agentId: UUID): Promise<void> {
    await this.queue.add('start', { agentId, type: 'start' });
    this.logger.log(`Dispatched start job for agent ${agentId}`);
  }

  /**
   * Validates that the agent exists and is in a resumable state, then
   * dispatches a `resume` job — unless the agent has other outstanding
   * consultations or user-input requests, in which case it stays paused
   * until all of them are resolved.
   *
   * @param replyContent - Fallback content injected as the first HumanMessage
   *   on resume, used only when the agent wasn't paused via this service
   *   (e.g. a manual retry). Pause-triggered resumes aggregate every response
   *   received since the agent paused instead.
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

    // Stay paused if the agent raised other requests that haven't been
    // answered yet — it should see every response it asked for, not just
    // the first one back.
    const outstanding = await this.countOutstanding(agentId);
    if (outstanding > 0) {
      this.logger.log(
        `Agent ${agentId} has ${outstanding} outstanding request(s) — staying paused`,
      );
      return agent;
    }

    // Combine every response received since this pause episode began, so
    // the resumed agent sees all the answers it asked for, not just the
    // last one to arrive.
    let aggregated: string | null = null;
    if (agent.pausedAt) {
      // Atomically claim this pause episode's resume: only the caller that
      // actually clears pausedAt proceeds to enqueue. Without this, two
      // near-simultaneous resume triggers (e.g. a retried fire-and-forget
      // completion notification) can both read the same pausedAt, both find
      // zero outstanding requests, and both enqueue a resume job carrying
      // the same aggregated reply — injecting it into the agent twice.
      const claim = await this.agentRepo
        .createQueryBuilder()
        .update(LcpAgent)
        .set({ pausedAt: () => 'NULL' })
        .where('id = :agentId', { agentId })
        .andWhere('pausedAt = :pausedAt', { pausedAt: agent.pausedAt })
        .execute();
      if (claim.affected === 0) {
        this.logger.log(
          `Agent ${agentId} resume already claimed by a concurrent call — skipping duplicate resume job`,
        );
        return agent;
      }
      aggregated = await this.collectRepliesSince(agentId, agent.pausedAt);
    }

    await this.queue.add('resume', {
      agentId: agent.id,
      type: 'resume',
      replyContent: aggregated ?? replyContent,
    });
    // Let any client observing the calling agent see it come back to life.
    this.events.emit(agent.id, {
      timestamp: new Date().toISOString(),
      kind: 'agent_status',
      data: { status: AgentStatus.Running, reason: 'resumed' },
    });
    this.logger.log(`Dispatched resume job for agent ${agent.id}`);
    return agent;
  }

  /** Counts the agent's still-unresolved consultations and user-input requests. */
  private async countOutstanding(agentId: UUID): Promise<number> {
    const [pendingConsultations, openConversations] = await Promise.all([
      this.consultRepo.count({
        where: { callingAgentId: agentId, status: 'pending' },
      }),
      this.convRepo.count({ where: { agentId, status: 'awaiting_user' } }),
    ]);
    return pendingConsultations + openConversations;
  }

  /**
   * Gathers every consultation result and user reply received for this
   * agent since `pausedAt`, joined into one message. Returns `null` if
   * nothing was found (e.g. the agent is being resumed for another reason).
   */
  private async collectRepliesSince(
    agentId: UUID,
    pausedAt: Date,
  ): Promise<string | null> {
    const [consultations, conversations] = await Promise.all([
      this.consultRepo.find({
        where: {
          callingAgentId: agentId,
          status: In(['complete', 'failed']),
          createdAt: MoreThanOrEqual(pausedAt),
        },
      }),
      this.convRepo.find({
        where: {
          agentId,
          status: 'closed',
          createdAt: MoreThanOrEqual(pausedAt),
        },
      }),
    ]);

    const conversationReplies = await Promise.all(
      conversations.map(async (conv) => {
        const reply = await this.msgRepo.findOne({
          where: { conversationId: conv.id, author: 'user' },
          order: { timestamp: 'DESC' },
        });
        return reply?.content;
      }),
    );

    const parts = [
      ...consultations
        .filter((c) => c.status === 'complete' && c.result)
        .map((c) => `Consultation response: ${c.result}`),
      ...consultations
        .filter((c) => c.status === 'failed')
        .map(
          (c) =>
            `Consultation FAILED: ${c.result ?? 'no reason given'}. ` +
            'Use your own judgement about how to proceed; if a response is ' +
            'essential, consider escalating to a user via request_user_input.',
        ),
      ...conversationReplies
        .filter((content): content is string => Boolean(content))
        .map((content) => `User response: ${content}`),
    ];

    return parts.length > 0 ? parts.join('\n\n') : null;
  }
}
