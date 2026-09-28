import {
  AgentStatus,
  assertRedisReachable,
  AuditEventType,
  buildAgentChangeSummary,
  Conversation,
  ConversationMessage,
  TcpAgent,
  PendingConsultation,
} from '@tcp/shared';
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
import { In, IsNull, Repository } from 'typeorm';
import { DbService } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { TcpAgentTemplate } from '../templates/TcpAgentTemplate';
import { SystemShutdownService } from './system-shutdown.service';

/** Payload dispatched to the `agent-jobs` BullMQ queue. */
interface AgentJob {
  agentId: string;
  type: 'start' | 'resume';
  /** User reply or consultation result injected as the first message on resume. */
  replyContent?: string;
}

/**
 * The replies waiting for a resuming agent, alongside the rows they came from
 * so they can be marked delivered once the resume job is safely queued.
 */
interface UndeliveredReplies {
  text: string;
  consultationIds: UUID[];
  conversationIds: UUID[];
}

/**
 * Injected as the opening message when resuming an agent that a shutdown drain
 * paused.
 *
 * Such an agent has no reply waiting for it, and tcp-agent treats a resume
 * carrying no content at all as a fresh run — rebuilding the whole initial
 * prompt on top of the checkpoint it should simply be continuing from.
 */
const SHUTDOWN_RESUME_PROMPT =
  'The system was shut down while you were working, and has now restarted. ' +
  'Continue from where you left off.';

/**
 * Creates and resumes agents by enqueuing jobs to the `agent-jobs` BullMQ queue,
 * which tcp-agent workers consume.
 *
 * The database record is created (or updated) here so callers can track
 * the agent immediately, without waiting for tcp-agent to pick up the job.
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
    @InjectRepository(TcpAgent)
    private readonly agentRepo: Repository<TcpAgent>,
    @InjectRepository(PendingConsultation)
    private readonly consultRepo: Repository<PendingConsultation>,
    @InjectRepository(Conversation)
    private readonly convRepo: Repository<Conversation>,
    @InjectRepository(ConversationMessage)
    private readonly msgRepo: Repository<ConversationMessage>,
    private readonly audit: AuditService,
    private readonly shutdown: SystemShutdownService,
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

  /**
   * Closes the queue connection gracefully on shutdown.
   *
   * Tolerates never having connected: `onModuleInit` may have thrown before
   * assigning `queue` (unreachable Redis), and closing a already-dead
   * connection can itself reject. Either would replace the real startup error
   * with a `Cannot read properties of undefined (reading 'close')` from
   * teardown — and in a test run, a throwing destroy hook can leave the
   * process hanging instead of failing cleanly.
   */
  async onModuleDestroy(): Promise<void> {
    try {
      await this.queue?.close();
    } catch (err) {
      this.logger.warn(
        `agent-jobs queue close failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Creates a new {@link TcpAgent} record and dispatches a `start` job
   * to tcp-agent via the BullMQ queue.
   */
  async startAgent(template: TcpAgentTemplate): Promise<TcpAgent> {
    const agent = await this.createAgent(template);
    await this.dispatchStartJob(agent.id);
    return agent;
  }

  /**
   * Creates a new {@link TcpAgent} record WITHOUT dispatching a job yet.
   * Use together with {@link dispatchStartJob} when other records (e.g. a
   * {@link PendingConsultation}) must be committed before the worker can
   * pick up the job — otherwise the worker may complete and call back
   * before those records exist.
   *
   * Publishes the new agent as an `idle` `state_change` once its row is
   * written — every creation path (dispatch, recovery, chat start) goes
   * through here, so a client never has to wait for the agent's first
   * `running` event to learn it exists (002.02 stage 1, cause C1: without
   * this, an agent queued behind another job could sit unannounced for as
   * long as the queue took to free up).
   */
  async createAgent(template: TcpAgentTemplate): Promise<TcpAgent> {
    const agent = await this.db.createAgent(template);
    await this.audit.record(
      agent.companyId,
      'agent',
      agent.id,
      AuditEventType.StateChange,
      {
        entity: 'agent',
        newStatus: AgentStatus.Idle,
        reason: 'agent created',
        summary: buildAgentChangeSummary({
          ...agent,
          status: AgentStatus.Idle,
        }),
      },
    );
    return agent;
  }

  /**
   * Dispatches a `start` job for an already-created agent.
   *
   * Refused while the system is draining: a drain that kept handing new work
   * to the workers it is waiting on would never quiesce.
   */
  async dispatchStartJob(agentId: UUID): Promise<void> {
    this.shutdown.assertAccepting();
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
   * @throws `ServiceUnavailableException` while the system is draining
   */
  async resumeAgent(agentId: UUID, replyContent?: string): Promise<TcpAgent> {
    this.shutdown.assertAccepting();
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

    // Combine every response this agent has not yet been given, so the resumed
    // agent sees all the answers it asked for, not just the last one to arrive.
    let replies: UndeliveredReplies | null = null;
    if (agent.pausedAt) {
      // Atomically claim this pause episode's resume: only the caller that
      // actually clears pausedAt proceeds to enqueue. Without this, two
      // near-simultaneous resume triggers (e.g. a retried fire-and-forget
      // completion notification) can both read the same pausedAt, both find
      // zero outstanding requests, and both enqueue a resume job carrying
      // the same aggregated reply — injecting it into the agent twice.
      const claim = await this.agentRepo
        .createQueryBuilder()
        .update(TcpAgent)
        .set({ pausedAt: () => 'NULL', pauseReason: () => 'NULL' })
        .where('id = :agentId', { agentId })
        .andWhere('pausedAt = :pausedAt', { pausedAt: agent.pausedAt })
        .execute();
      if (claim.affected === 0) {
        this.logger.log(
          `Agent ${agentId} resume already claimed by a concurrent call — skipping duplicate resume job`,
        );
        return agent;
      }
      replies = await this.collectUndeliveredReplies(agentId);
    }

    await this.queue.add('resume', {
      agentId: agent.id,
      type: 'resume',
      replyContent:
        replies?.text ??
        replyContent ??
        (agent.pauseReason === 'shutdown' ? SHUTDOWN_RESUME_PROMPT : undefined),
    });
    // Only once the job is safely queued: a failure above must leave these
    // undelivered, so the next resume picks them up rather than losing them.
    if (replies) await this.markDelivered(replies);
    // No event published here (002.02 stage 2): the DB still reads `paused`
    // until the worker actually picks the job up, and with one worker slot
    // that can be tens of seconds away. Publishing `running` at enqueue time
    // told clients something the database didn't yet agree with. The
    // worker's own `running` write (`agent-loop.service.ts` `run()`, via
    // `RunStatusService`) is the persist-then-publish source of truth.
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
   * Gathers every consultation result and user reply this agent has not yet
   * been given, joined into one message. Returns `null` if there are none
   * (e.g. the agent is being resumed for another reason).
   *
   * Scoping is by delivery state, not by time. The obvious alternative — take
   * everything created since the agent paused — compares `createdAt`, stamped
   * by the database's clock, against `pausedAt`, stamped by the application's.
   * Those two writes are milliseconds apart, so a database clock lagging by a
   * few milliseconds silently drops the very answer the agent is waiting for,
   * and it resumes with an empty payload. Measured at 1–3ms of headroom before
   * this changed.
   */
  private async collectUndeliveredReplies(
    agentId: UUID,
  ): Promise<UndeliveredReplies | null> {
    const [consultations, conversations] = await Promise.all([
      this.consultRepo.find({
        where: {
          callingAgentId: agentId,
          status: In(['complete', 'failed']),
        },
      }),
      this.convRepo.find({
        where: {
          agentId,
          status: 'closed',
          repliesDeliveredAt: IsNull(),
        },
      }),
    ]);

    // Every user message, not just the most recent one: a user who answers in
    // two messages before the conversation closes has said two things, and an
    // agent that only ever sees the last of them loses the rest of the answer.
    // Oldest first, so the agent reads them in the order they were written.
    const conversationReplies = await Promise.all(
      conversations.map((conv) =>
        this.msgRepo.find({
          where: { conversationId: conv.id, author: 'user' },
          order: { timestamp: 'ASC' },
        }),
      ),
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
        .flat()
        .map((message) => message.content)
        .filter(Boolean)
        .map((content) => `User response: ${content}`),
    ];

    if (parts.length === 0) return null;
    return {
      text: parts.join('\n\n'),
      consultationIds: consultations.map((c) => c.id),
      conversationIds: conversations.map((c) => c.id),
    };
  }

  /**
   * Records that these replies have been handed to the agent, so a later
   * resume does not deliver them a second time.
   */
  private async markDelivered(replies: UndeliveredReplies): Promise<void> {
    const deliveredAt = new Date();
    await Promise.all([
      replies.consultationIds.length > 0
        ? this.consultRepo.update(replies.consultationIds, {
            status: 'consumed',
          })
        : Promise.resolve(),
      replies.conversationIds.length > 0
        ? this.convRepo.update(replies.conversationIds, {
            repliesDeliveredAt: deliveredAt,
          })
        : Promise.resolve(),
    ]);
  }
}
