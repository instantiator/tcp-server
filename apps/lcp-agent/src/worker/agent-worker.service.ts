import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import { UUID } from 'crypto';
import { AgentLoopService } from '../agent/agent-loop.service';
import { AgentRegistryService } from '../registry/agent-registry.service';

/** Payload shape expected on the `agent-jobs` queue. */
interface AgentJobPayload {
  agentId: UUID;
  type: 'start' | 'resume';
  /** Content to inject as the first HumanMessage on resume (user reply or consultation result). */
  replyContent?: string;
}

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

  constructor(
    private readonly loop: AgentLoopService,
    private readonly registry: AgentRegistryService,
    private readonly config: ConfigService,
  ) {}

  /** Starts the BullMQ worker on module init. */
  async onModuleInit(): Promise<void> {
    const redisUrl = this.config.getOrThrow<string>('REDIS_URL');

    this.worker = new Worker<AgentJobPayload>(
      'agent-jobs',
      async (job) => {
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

        try {
          await this.loop.run(agentId, replyContent, abortController);
        } finally {
          this.registry.deregister(agentId);
        }
      },
      {
        connection: { url: redisUrl },
        // ponytail: move to config when per-role resource limits are addressed (see 003.3)
        concurrency: 5,
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

    this.logger.log('Agent worker started, listening on agent-jobs queue');
  }

  /** Closes the worker gracefully on module destroy. */
  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
  }
}
