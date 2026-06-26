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
  onModuleInit(): void {
    const redisUrl = this.config.getOrThrow<string>('REDIS_URL');

    this.worker = new Worker<AgentJobPayload>(
      'agent-jobs',
      async (job) => {
        const { agentId, type, replyContent } = job.data;
        this.logger.log(`Processing ${type} job for agent ${agentId}`);

        if (this.registry.isRunning(agentId)) {
          this.logger.warn(
            `Agent ${agentId} is already running — skipping duplicate job`,
          );
          return;
        }

        await this.loop.run(agentId, replyContent);
      },
      {
        connection: { url: redisUrl },
        // ponytail: move to config when per-role resource limits are addressed (see 003.3)
        concurrency: 5,
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

    this.logger.log('Agent worker started, listening on agent-jobs queue');
  }

  /** Closes the worker gracefully on module destroy. */
  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
  }
}
