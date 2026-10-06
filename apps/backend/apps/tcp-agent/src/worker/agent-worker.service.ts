import { AgentStatus, assertRedisReachable, TcpAgent } from '@tcp/shared';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DelayedError, Job, Queue, Worker } from 'bullmq';
import { UUID } from 'crypto';
import { Repository } from 'typeorm';
import { AgentLoopService } from '../agent/agent-loop.service';
import { resolveRunLimits } from '../agent/run-environment.service';
import { AgentRunStatusService } from '../agent/run-status.service';
import { AgentRegistryService } from '../registry/agent-registry.service';
import {
  ModelSlotService,
  UNLIMITED_LEASE,
  type ModelSlotLease,
} from './model-slot.service';
import { ShutdownListenerService } from './shutdown-listener.service';

/** Payload shape expected on the `agent-jobs` queue. */
interface AgentJobPayload {
  agentId: UUID;
  type: 'start' | 'resume';
  /** Content to inject as the first HumanMessage on resume (user reply or consultation result). */
  replyContent?: string;
}

/**
 * How many jobs BullMQ hands the processor at once. Not a limit on agent runs
 * — `MODEL_CONCURRENCY`'s pools do that in {@link ModelSlotService} — just
 * room for every job a pool could admit, plus the ones only passing through
 * to be deferred.
 *
 * ponytail: a fixed ceiling; raise it if a deployment sets pools above it.
 */
const WORKER_CONCURRENCY = 100;

/**
 * How long a job refused a model slot waits before checking again. A release
 * promotes the next waiter straight away, so this only matters when that
 * promotion is missed (e.g. the waiter was deferred by a process that has
 * since restarted).
 */
const SLOT_RECHECK_MS = 30_000;

/** Statuses no job can move an agent on from; a job for one is stale. */
const FINISHED = new Set<AgentStatus>([
  AgentStatus.Completed,
  AgentStatus.Cancelled,
]);

/**
 * BullMQ worker that consumes jobs from the `agent-jobs` queue and
 * delegates to {@link AgentLoopService} to run or resume the agent loop.
 *
 * Future work: add queue observability (depth, stalled-job detection,
 * per-thread latency). Prepare an ADR before scaling beyond one instance.
 */
@Injectable()
export class AgentWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentWorkerService.name);
  private worker!: Worker<AgentJobPayload>;
  /** Used only to promote a waiting job when a slot frees. */
  private queue?: Queue<AgentJobPayload>;

  constructor(
    private readonly loop: AgentLoopService,
    private readonly registry: AgentRegistryService,
    private readonly config: ConfigService,
    private readonly shutdown: ShutdownListenerService,
    private readonly slots: ModelSlotService,
    private readonly status: AgentRunStatusService,
    @InjectRepository(TcpAgent)
    private readonly agentRepo: Repository<TcpAgent>,
  ) {}

  /** Starts the BullMQ worker on module init. */
  async onModuleInit(): Promise<void> {
    const redisUrl = this.config.getOrThrow<string>('REDIS_URL');

    // Fail fast if Redis is unreachable. Without this, the Worker below (and
    // its waitUntilReady() call) would block startup indefinitely against a
    // downed Redis rather than erroring with a clear message.
    await assertRedisReachable(redisUrl);

    if (this.config.get<string>('AGENT_WORKER_CONCURRENCY')) {
      this.logger.warn(
        'AGENT_WORKER_CONCURRENCY is no longer used and is ignored. Set MODEL_CONCURRENCY\'s "local" and "remote" pool limits instead (see .env.example).',
      );
    }

    this.queue = new Queue<AgentJobPayload>('agent-jobs', {
      connection: { url: redisUrl },
    });
    this.queue.on('error', (err) => {
      this.logger.warn(`agent-jobs queue error: ${err.message}`);
    });

    this.worker = new Worker<AgentJobPayload>(
      'agent-jobs',
      async (job, token) => {
        const { agentId, type, replyContent } = job.data;
        this.logger.log(`Processing ${type} job for agent ${agentId}`);

        // Check-and-register must happen with no `await` in between — a
        // stalled-job retry (BullMQ re-dispatches a job whose lock renewal
        // failed, e.g. because a slow local model kept a turn running past
        // the default 30s lock duration, while the original invocation is
        // still very much alive) must never see `isRunning() === false` for
        // an agent that's already mid-run. `AgentLoopService.run` only
        // fetches the agent (an `await`) before it would otherwise register,
        // so registration happens here instead, synchronously, before handing
        // off to `run`.
        if (this.registry.isRunning(agentId)) {
          this.logger.warn(
            `Agent ${agentId} is already running — skipping duplicate job`,
          );
          return;
        }
        const abortController = new AbortController();
        this.registry.register(agentId, abortController);

        let lease: ModelSlotLease = UNLIMITED_LEASE;
        try {
          const admitted = await this.admit(job, token);
          if (!admitted) return;
          lease = admitted;
          await this.loop.run(agentId, replyContent, abortController);
        } finally {
          const next = lease.release();
          if (next) void this.promote(next);
          this.registry.deregister(agentId);
          // A drain is waiting on exactly this number reaching zero.
          this.shutdown.reportActive();
        }
      },
      {
        connection: { url: redisUrl },
        concurrency: WORKER_CONCURRENCY,
        // BullMQ's own default (30s) is far shorter than a single LLM turn can
        // take with a slow local model — the worker auto-renews the lock well
        // before it expires, but a transient Redis hiccup during any one of
        // the many renewals over a long run can still miss the deadline,
        // making BullMQ believe the job stalled and re-dispatch a duplicate.
        // The in-memory registry guard (see the processor above) closes that
        // race structurally, but a generous lock duration avoids relying on
        // it as the only line of defence.
        lockDuration: 5 * 60 * 1000, // 5m
        maxStalledCount: 2,
      },
    );

    this.worker.on('completed', (job) => {
      this.logger.log(`Job ${job.id} completed for agent ${job.data.agentId}`);
    });

    this.worker.on('failed', (job, err) => {
      this.logger.error(
        `Job ${job?.id} failed for agent ${job?.data.agentId}: ${err.message}`,
      );
    });

    this.worker.on('error', (err) => {
      this.logger.warn(`Worker connection error: ${err.message}`);
    });

    // Block module init until the underlying Redis connection has actually
    // finished connecting. Without this, a module torn down quickly after
    // start (e.g. a health-check-only e2e test whose `afterAll` closes the
    // app immediately) can call `worker.close()` while the connection is
    // still mid-handshake; BullMQ's `close()` strips its own listeners once
    // it's done, but the connection's original constructor-time promise can
    // still reject afterwards and re-emit 'error' on an object with no
    // listeners left, crashing the process. Waiting for 'ready' here means
    // that promise has already settled by the time close() can ever run.
    await this.worker.waitUntilReady();

    // Hand the worker over so a drain can stop it taking further jobs.
    this.shutdown.bindWorker(this.worker);

    this.logger.log('Agent worker started, listening on agent-jobs queue');
  }

  /**
   * Closes the worker gracefully on module destroy.
   *
   * Tolerates never having started: `onModuleInit` may have thrown before
   * assigning `worker` (unreachable Redis), and closing an already-dead
   * connection can itself reject. Either would replace the real startup error
   * with a `Cannot read properties of undefined (reading 'close')` from
   * teardown — and in a test run, a throwing destroy hook can leave the
   * process hanging instead of failing cleanly.
   */
  async onModuleDestroy(): Promise<void> {
    try {
      await this.worker?.close();
      await this.queue?.close();
    } catch (err) {
      this.logger.warn(
        `agent worker close failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Decides whether a job's run may start now.
   *
   * @returns The run's model-slot lease; `null` for a stale job (its agent
   *   already completed or was cancelled, so running it would overwrite that
   *   with `running`).
   * @throws BullMQ's `DelayedError` after moving the job back to the delayed
   *   set, when the run's pool or endpoint is full. The agent shows as
   *   `queued` meanwhile.
   */
  private async admit(
    job: Job<AgentJobPayload>,
    token: string | undefined,
  ): Promise<ModelSlotLease | null> {
    const { agentId } = job.data;
    const agent = await this.agentRepo.findOne({
      where: { id: agentId },
      relations: { role: true, company: true },
    });
    // A missing agent or LLM config is the loop's to report, as before.
    if (!agent) return UNLIMITED_LEASE;
    if (FINISHED.has(agent.status)) {
      this.logger.log(
        `Agent ${agentId} is already ${agent.status} — dropping stale job`,
      );
      return null;
    }
    const llm = resolveRunLimits(agent, this.config)?.llmConfig;
    const limits = llm && this.slots.limitsFor(llm);
    if (!limits) return UNLIMITED_LEASE;

    const lease = this.slots.tryAcquire(limits, job.id ?? agentId);
    if (lease) return lease;

    this.logger.log(
      `Agent ${agentId} waiting for a ${limits.pool} model slot (${limits.endpointKey})`,
    );
    await this.status.markQueued(agent);
    await job.moveToDelayed(Date.now() + SLOT_RECHECK_MS, token);
    throw new DelayedError();
  }

  /**
   * Moves a waiting job out of the delayed set so it re-checks for a slot
   * now. Failure is harmless: the job may have been removed or already be
   * running, and otherwise its own delay brings it back.
   */
  private async promote(jobId: string): Promise<void> {
    if (!this.queue) return;
    try {
      const job = await Job.fromId(this.queue, jobId);
      await job?.promote();
    } catch (err) {
      this.logger.debug(
        `Could not promote job ${jobId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
