import { UUID } from 'crypto';
import {
  assertRedisReachable,
  KnowledgeChunk,
  TcpCompany,
  TcpRole,
  LlmConfig,
  resolveEmbeddingConfig,
  resolveEnvEmbeddingConfig,
} from '@tcp/shared';
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, Queue, Worker } from 'bullmq';
import { IsNull, Repository } from 'typeorm';
import { KnowledgeScope, parseKnowledgePath } from '../storage/storage-keys';
import { StorageObject, StorageService } from '../storage/storage.service';
import {
  fingerprintListing,
  KnowledgeIndexStateService,
} from './knowledge-index-state.service';
import { RagIndexService } from './rag-index.service';

/** BullMQ queue name for scope-rebuild and reconciliation-poll jobs. */
const QUEUE_NAME = 'knowledge-reindex';

/** Payload for a scope rebuild. Carries the scope generation it was enqueued at. */
interface RebuildJob {
  companyId: UUID;
  /** Role scope, or `null` for the company-shared scope. */
  roleId: UUID | null;
  generation: number;
}

/** BullMQ options every rebuild job is enqueued with. */
const JOB_OPTIONS = { removeOnComplete: true, removeOnFail: 100 };

/**
 * Keeps RAG embeddings in sync with the contents of each knowledge scope — a
 * role's `knowledge/{role_slug}/` folder or a company's `knowledge/shared/`
 * folder — and provides the single path by which embeddings are (re)built.
 *
 * Two triggers feed one BullMQ queue:
 *
 * 1. A write hook: {@link StorageService} calls {@link bumpByKey} after any
 *    successful write under a `knowledge/` prefix.
 * 2. A reconciliation poller: a repeatable job that fingerprints every scope's
 *    storage listing and rebuilds any that drifted from the last indexed
 *    fingerprint — catching out-of-band edits (e.g. via the MinIO console).
 *
 * Restart-on-change is enforced with the per-scope generation counter owned by
 * {@link KnowledgeIndexStateService}: every trigger atomically
 * increments the counter and enqueues a job carrying the new value. The worker
 * skips a job older than the current generation, and aborts + re-enqueues if
 * the generation changes mid-rebuild, so a burst of writes collapses to a
 * single up-to-date rebuild with no half-indexed state.
 */
@Injectable()
export class KnowledgeReindexService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KnowledgeReindexService.name);
  private queue!: Queue<RebuildJob>;
  private worker!: Worker<RebuildJob>;
  /** Reconciliation poll timer — an in-process interval, not a BullMQ repeatable job (see onModuleInit). */
  private pollTimer?: NodeJS.Timeout;
  /** Companies already logged as having no embeddingConfig, to avoid log spam. */
  private readonly loggedNoConfig = new Set<string>();

  constructor(
    private readonly config: ConfigService,
    @Inject(forwardRef(() => StorageService))
    private readonly storage: StorageService,
    private readonly ragIndex: RagIndexService,
    private readonly indexState: KnowledgeIndexStateService,
    @InjectRepository(KnowledgeChunk)
    private readonly chunkRepo: Repository<KnowledgeChunk>,
    @InjectRepository(TcpCompany)
    private readonly companyRepo: Repository<TcpCompany>,
    @InjectRepository(TcpRole)
    private readonly roleRepo: Repository<TcpRole>,
  ) {}

  /** Connects the queue, starts the rebuild worker, and starts the reconciliation poll timer. */
  async onModuleInit(): Promise<void> {
    const url = this.config.getOrThrow<string>('REDIS_URL');
    // Fail fast if Redis is unreachable (see AgentOrchestrationService for why).
    await assertRedisReachable(url);

    this.queue = new Queue<RebuildJob>(QUEUE_NAME, { connection: { url } });
    // A missing 'error' listener turns a post-close "Connection is closed" into
    // an unhandled rejection that can crash unrelated test suites — always log
    // and swallow.
    this.queue.on('error', (err) => {
      this.logger.warn(`${QUEUE_NAME} queue error: ${err.message}`);
    });

    this.worker = new Worker<RebuildJob>(
      QUEUE_NAME,
      async (job) => this.rebuild(job),
      // Serialise rebuilds: they hammer the embedding endpoint and the
      // generation logic already collapses concurrent triggers to one run.
      // ponytail: concurrency 1 — raise if reindex throughput matters.
      { connection: { url }, concurrency: 1 },
    );
    this.worker.on('error', (err) => {
      this.logger.warn(`${QUEUE_NAME} worker error: ${err.message}`);
    });
    this.worker.on('failed', (job, err) => {
      this.logger.error(`${QUEUE_NAME} job ${job?.id} failed: ${err.message}`);
    });
    await this.worker.waitUntilReady();

    // The reconciliation poller is an in-process interval rather than a BullMQ
    // repeatable job on purpose: a repeatable job persists in Redis and, in a
    // shared-Redis test run where many short-lived apps boot and tear down,
    // fires under whichever app happens to be alive at the interval — starving
    // unrelated work. A plain interval is scoped to this instance's lifetime
    // (so a sub-interval test app never triggers it) and is `unref`'d so it can
    // never keep the process alive at shutdown. Each running tcp-server polls
    // independently; bumps are idempotent (generation-guarded), so overlap is
    // harmless.
    const every = this.config.get<number>('KNOWLEDGE_POLL_INTERVAL_MS', 60000);
    this.pollTimer = setInterval(() => {
      void this.poll().catch((err: unknown) => {
        this.logger.warn(
          `Knowledge reconciliation poll failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, every);
    this.pollTimer.unref();

    this.logger.log(
      `Knowledge reindex worker started; poll interval ${every}ms`,
    );
  }

  /** Stops the poll timer and closes the worker and queue on shutdown. */
  async onModuleDestroy(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    // Force-close the worker so a shutdown mid-rebuild (e.g. a test's afterAll)
    // can never block on an in-flight job. Settle both regardless of individual
    // failures so one slow close can't strand the other.
    await Promise.allSettled([this.worker?.close(true), this.queue?.close()]);
  }

  // Triggers

  /**
   * Atomically bumps a scope's generation and enqueues a rebuild carrying it.
   * The unit of reindexing is a whole scope, so the filename is irrelevant.
   */
  async bump(companyId: UUID, roleId: UUID | null): Promise<void> {
    const generation = await this.indexState.increment(companyId, roleId);
    await this.queue.add(
      'rebuild',
      { companyId, roleId, generation },
      JOB_OPTIONS,
    );
    this.logger.debug(
      `Bumped scope company=${companyId} role=${roleId ?? 'shared'} → gen ${generation}`,
    );
  }

  /**
   * Resolves an object key to its knowledge scope and bumps it. A no-op for
   * keys outside any `knowledge/` folder, or whose company/role slug does not
   * resolve. Called by the storage write hook for every affected key.
   */
  async bumpByKey(key: string): Promise<void> {
    const scope = parseKnowledgePath(key);
    if (!scope) return;
    const company = await this.companyRepo.findOneBy({
      slug: scope.companySlug,
    });
    if (!company) return;
    let roleId: UUID | null = null;
    if (scope.roleSlug !== null) {
      const role = await this.roleRepo.findOneBy({
        companyId: company.id,
        slug: scope.roleSlug,
      });
      if (!role) return;
      roleId = role.id;
    }
    await this.bump(company.id, roleId);
  }

  /** Bumps every scope of a company (shared + each role) — backs the manual reindex trigger. */
  async bumpCompany(company: TcpCompany): Promise<void> {
    await this.bump(company.id, null);
    const roles = await this.roleRepo.findBy({ companyId: company.id });
    for (const role of roles) {
      await this.bump(company.id, role.id);
    }
  }

  /** True if a rebuild job for this scope is currently active, waiting, or delayed. */
  async isRebuilding(companyId: UUID, roleId: UUID | null): Promise<boolean> {
    const jobs = await this.queue.getJobs(['active', 'waiting', 'delayed']);
    return jobs.some(
      (job) => job.data.companyId === companyId && job.data.roleId === roleId,
    );
  }

  // Rebuild

  /**
   * Rebuilds one scope: re-lists, re-chunks and re-embeds every file, then
   * removes chunks for documents that no longer exist and records the
   * fingerprint of the listing it indexed.
   *
   * Skips stale jobs (a newer generation is already queued) and aborts +
   * re-enqueues if the generation changes mid-rebuild.
   */
  async rebuild(job: Pick<Job<RebuildJob>, 'data'>): Promise<void> {
    const { companyId, roleId, generation } = job.data;

    const company = await this.companyRepo.findOneBy({ id: companyId });
    if (!company) return;
    const embeddingConfig = this.resolveEmbedding(company);
    if (!embeddingConfig) return;

    if (generation < (await this.indexState.current(companyId, roleId))) {
      this.logger.debug(
        `Skipping stale rebuild (gen ${generation}) for company=${companyId} role=${roleId ?? 'shared'}`,
      );
      return;
    }

    const scope = await this.resolveScope(company, roleId);
    if (!scope) return;

    // Listing sits outside the try on purpose: a storage failure here is not
    // an indexing failure, and must not overwrite the scope's recorded state.
    const files = await this.storage.listKnowledgeFiles(scope);

    try {
      await this.indexScope(job.data, files, embeddingConfig);
    } catch (err) {
      // Most commonly the embedding endpoint being unreachable/misconfigured
      // (see EmbeddingService) — recorded on the scope's state row so the
      // knowledge endpoints can surface it, then rethrown so BullMQ marks the
      // job failed.
      const message = err instanceof Error ? err.message : String(err);
      await this.indexState.recordFailure(
        companyId,
        roleId,
        generation,
        message,
      );
      this.logger.error(
        `Reindex failed for company=${companyId} role=${roleId ?? 'shared'} (gen ${generation}): ${message}`,
      );
      throw err;
    }
  }

  /**
   * Re-embeds every document in the scope, drops chunks for documents that have
   * gone, and records the fingerprint of the listing it indexed. Returns early
   * (having re-enqueued) if a write lands mid-run.
   */
  private async indexScope(
    { companyId, roleId, generation }: RebuildJob,
    files: StorageObject[],
    embeddingConfig: LlmConfig,
  ): Promise<void> {
    const listedKeys = new Set<string>();

    for (const file of files) {
      // Re-read the generation between documents so a write landing mid-rebuild
      // aborts this run and a fresh one re-processes everything.
      const current = await this.indexState.current(companyId, roleId);
      if (current !== generation) {
        this.logger.log(
          `Generation changed ${generation}→${current} mid-rebuild for company=${companyId} role=${roleId ?? 'shared'} — re-enqueuing`,
        );
        await this.queue.add(
          'rebuild',
          { companyId, roleId, generation: current },
          JOB_OPTIONS,
        );
        return;
      }
      const content = await this.storage.readFile(file.key);
      if (content === null) continue;
      await this.ragIndex.ingestDocument(
        companyId,
        roleId,
        file.key,
        content,
        embeddingConfig,
      );
      listedKeys.add(file.key);
    }

    await this.removeStaleChunks(companyId, roleId, listedKeys);
    await this.indexState.recordIndexed(
      companyId,
      roleId,
      generation,
      fingerprintListing(files),
    );
    this.logger.log(
      `Reindexed ${listedKeys.size} document(s) for company=${companyId} role=${roleId ?? 'shared'} (gen ${generation})`,
    );
  }

  // Reconciliation poller

  /**
   * One reconciliation cycle: for every company with a resolvable embedding
   * config (its own, or the environment fallback), fingerprint each scope's
   * storage listing and bump any scope that drifted from its last indexed
   * fingerprint.
   */
  async poll(): Promise<void> {
    const envEmbeddingConfig = resolveEnvEmbeddingConfig(this.config);
    const companies = await this.companyRepo.find();
    for (const company of companies) {
      if (!resolveEmbeddingConfig(company, envEmbeddingConfig)) continue;
      const roles = await this.roleRepo.findBy({ companyId: company.id });
      const scopes: (TcpRole | null)[] = [null, ...roles];
      for (const role of scopes) {
        const roleId = role?.id ?? null;
        try {
          await this.reconcileScope(company, role, roleId);
        } catch (err) {
          // One unreachable/misconfigured scope must not abort the whole cycle.
          this.logger.warn(
            `Poll failed for company=${company.id} role=${roleId ?? 'shared'}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  /** Bumps a single scope if its live storage listing has drifted from the recorded fingerprint. */
  private async reconcileScope(
    company: TcpCompany,
    role: TcpRole | null,
    roleId: UUID | null,
  ): Promise<void> {
    const scope: KnowledgeScope = {
      companySlug: company.slug,
      roleSlug: role?.slug ?? null,
    };
    const files = await this.storage.listKnowledgeFiles(scope);
    const state = await this.indexState.find(company.id, roleId);
    // An empty, never-indexed scope has nothing to reconcile — don't bump it
    // every cycle forever.
    if (files.length === 0 && !state) return;
    if (state?.fingerprint !== fingerprintListing(files)) {
      this.logger.log(
        `Poller detected drift for company=${company.id} role=${roleId ?? 'shared'} — bumping`,
      );
      await this.bump(company.id, roleId);
    }
  }

  // Helpers

  /**
   * The company's embedding config, or `null` when neither it nor the
   * environment provides one — logged once per company, since without it there
   * is nothing this service can do for that company at all.
   */
  private resolveEmbedding(company: TcpCompany): LlmConfig | null {
    const embeddingConfig = resolveEmbeddingConfig(
      company,
      resolveEnvEmbeddingConfig(this.config),
    );
    if (embeddingConfig) return embeddingConfig;
    if (!this.loggedNoConfig.has(company.id)) {
      this.loggedNoConfig.add(company.id);
      this.logger.log(
        `Company ${company.id} has no embeddingConfig, and no EMBEDDING_* env ` +
          'fallback is configured — skipping knowledge reindex',
      );
    }
    return null;
  }

  /** Removes chunks for documents present in the DB but absent from the current listing. */
  private async removeStaleChunks(
    companyId: UUID,
    roleId: UUID | null,
    listedKeys: Set<string>,
  ): Promise<void> {
    const rows = await this.chunkRepo.find({
      where: { companyId, roleId: roleId ?? IsNull() },
      select: { documentPath: true },
    });
    const distinct = new Set(rows.map((r) => r.documentPath));
    for (const documentPath of distinct) {
      if (!listedKeys.has(documentPath)) {
        await this.ragIndex.removeDocument(roleId, documentPath);
      }
    }
  }

  /** Builds the storage {@link KnowledgeScope} for a rebuild, resolving the role slug when needed. */
  private async resolveScope(
    company: TcpCompany,
    roleId: UUID | null,
  ): Promise<KnowledgeScope | null> {
    if (roleId === null) {
      return { companySlug: company.slug, roleSlug: null };
    }
    const role = await this.roleRepo.findOneBy({ id: roleId });
    if (!role) return null;
    return { companySlug: company.slug, roleSlug: role.slug };
  }
}
