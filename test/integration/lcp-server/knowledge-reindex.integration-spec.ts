import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  EmbeddingService,
  KnowledgeChunk,
  KnowledgeIndexState,
  LcpCompany,
  LcpRole,
} from '@lcp/shared';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { AuditService } from '../../../apps/lcp-server/src/audit/audit.service';
import { KnowledgeReindexService } from '../../../apps/lcp-server/src/rag/knowledge-reindex.service';
import { RagIndexService } from '../../../apps/lcp-server/src/rag/rag-index.service';
import { MinioStorageAdapter } from '../../../apps/lcp-server/src/storage/minio-storage.adapter';
import { requireEnv } from '../../support/require-env';

/**
 * End-to-end integration coverage for the knowledge-reindex pipeline against
 * the real Postgres + Redis + MinIO + stub-llm stack:
 *
 * - the storage write hook enqueues a rebuild and chunks appear/disappear;
 * - the reconciliation poller detects a direct (hook-bypassing) MinIO edit.
 *
 * Services are wired by hand rather than through Nest DI so the deliberate
 * storage↔reindex cycle can be closed explicitly with the real Worker running.
 * Run via ./scripts/run-integration-tests.sh
 */
const ENDPOINT = requireEnv('MINIO_ENDPOINT');
const DATABASE_URL = requireEnv('DATABASE_URL');
const REDIS_URL = requireEnv('REDIS_URL');
const STUB_LLM_URL = requireEnv('STUB_LLM_URL');
const BUCKET = 'lcp-reindex-test';
const COMPANY_SLUG = 'reindex-co';
const ROLE_SLUG = 'analyst';
const OKF = (body: string) => `---\ntitle: Doc\n---\n\n${body}`;

function makeConfig(): ConfigService {
  const vals: Record<string, string> = {
    MINIO_ENDPOINT: ENDPOINT,
    MINIO_ACCESS_KEY: process.env.MINIO_ACCESS_KEY ?? 'lcp-access-key',
    MINIO_SECRET_KEY: process.env.MINIO_SECRET_KEY ?? 'lcp-secret-key',
    REDIS_URL,
  };
  return {
    getOrThrow: (k: string) => vals[k],
    // Large poll interval so the repeatable job never fires on its own —
    // the poller test drives poll() directly.
    get: (k: string, fallback?: unknown) =>
      k === 'MINIO_BUCKET_PREFIX'
        ? BUCKET
        : k === 'KNOWLEDGE_POLL_INTERVAL_MS'
          ? 3_600_000
          : fallback,
  } as unknown as ConfigService;
}

/** Polls `fn` until it resolves truthy, or throws after `timeoutMs`. */
async function waitFor<T>(
  fn: () => Promise<T>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe('KnowledgeReindex (integration)', () => {
  let ds: DataSource;
  let s3: S3Client;
  let reindex: KnowledgeReindexService;
  let adapter: MinioStorageAdapter;
  let companyRepo: Repository<LcpCompany>;
  let chunkRepo: Repository<KnowledgeChunk>;
  let company: LcpCompany;
  let role: LcpRole;

  async function countChunks(roleId: string | null): Promise<number> {
    const rows = await ds.query<{ count: string }[]>(
      `SELECT COUNT(*)::int AS count FROM knowledge_chunk
       WHERE "companyId" = $1 AND ${roleId === null ? '"roleId" IS NULL' : '"roleId" = $2'}`,
      roleId === null ? [company.id] : [company.id, roleId],
    );
    return Number(rows[0].count);
  }

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      url: DATABASE_URL,
      entities: [LcpCompany, LcpRole, KnowledgeChunk, KnowledgeIndexState],
      synchronize: true,
    });
    await ds.initialize();
    // pgvector column is invisible to TypeORM — add it (and the extension) by hand.
    await ds.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await ds.query(
      `ALTER TABLE "knowledge_chunk" ADD COLUMN IF NOT EXISTS embedding vector(768)`,
    );

    s3 = new S3Client({
      endpoint: ENDPOINT,
      region: 'us-east-1',
      credentials: {
        accessKeyId: process.env.MINIO_ACCESS_KEY ?? 'lcp-access-key',
        secretAccessKey: process.env.MINIO_SECRET_KEY ?? 'lcp-secret-key',
      },
      forcePathStyle: true,
    });
    try {
      await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    }

    companyRepo = ds.getRepository(LcpCompany);
    const roleRepo = ds.getRepository(LcpRole);
    chunkRepo = ds.getRepository(KnowledgeChunk);
    const stateRepo = ds.getRepository(KnowledgeIndexState);

    company = await companyRepo.save(
      companyRepo.create({
        slug: COMPANY_SLUG,
        name: 'Reindex Co',
        description: 'test',
        embeddingConfig: {
          provider: 'openai',
          model: 'stub-embed',
          baseUrl: STUB_LLM_URL,
          apiKey: 'test',
        },
      }),
    );
    role = await roleRepo.save(
      roleRepo.create({
        slug: ROLE_SLUG,
        name: 'Analyst',
        description: 'test',
        systemPromptTemplate: 'x',
        knowledgeDomains: [],
        mcpServerList: [],
        company,
        companyId: company.id,
      }),
    );

    const config = makeConfig();
    const audit = { record: jest.fn() } as unknown as AuditService;
    // Construct the adapter first with a placeholder reindex, then close the
    // deliberate cycle once the reindex service exists.
    adapter = new MinioStorageAdapter(
      config,
      audit,
      companyRepo,
      undefined as unknown as KnowledgeReindexService,
    );
    const ragIndex = new RagIndexService(new EmbeddingService(), chunkRepo, ds);
    reindex = new KnowledgeReindexService(
      config,
      adapter,
      ragIndex,
      stateRepo,
      chunkRepo,
      companyRepo,
      roleRepo,
      ds,
    );
    (adapter as unknown as { reindex: KnowledgeReindexService }).reindex =
      reindex;

    await adapter.ensureBucketExists();
    await reindex.onModuleInit();
  }, 60_000);

  afterAll(async () => {
    await reindex?.onModuleDestroy();
    const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET }));
    await Promise.all(
      (list.Contents ?? []).map((o) =>
        s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: o.Key! })),
      ),
    );
    if (company) {
      await ds.query(`DELETE FROM knowledge_chunk WHERE "companyId" = $1`, [
        company.id,
      ]);
      await ds.query(
        `DELETE FROM knowledge_index_state WHERE "companyId" = $1`,
        [company.id],
      );
    }
    await ds.getRepository(LcpRole).createQueryBuilder().delete().execute();
    await companyRepo.createQueryBuilder().delete().execute();
    s3.destroy();
    await ds.destroy();
  }, 30_000);

  it('write hook indexes a knowledge document for the role scope', async () => {
    const key = `${COMPANY_SLUG}/knowledge/${ROLE_SLUG}/report.md`;
    await adapter.writeFile(key, OKF('The quarterly numbers look strong.'));

    const chunks = await waitFor(async () =>
      (await countChunks(role.id)) > 0 ? await countChunks(role.id) : 0,
    );
    expect(chunks).toBeGreaterThan(0);

    // Embeddings were written (not left null).
    const withEmbedding = await ds.query<{ count: string }[]>(
      `SELECT COUNT(*)::int AS count FROM knowledge_chunk
       WHERE "companyId" = $1 AND "roleId" = $2 AND embedding IS NOT NULL`,
      [company.id, role.id],
    );
    expect(Number(withEmbedding[0].count)).toBe(chunks);
  }, 30_000);

  it('write hook removes chunks when the document is deleted', async () => {
    const key = `${COMPANY_SLUG}/knowledge/${ROLE_SLUG}/report.md`;
    await adapter.deleteFile(key);
    const remaining = await waitFor(async () =>
      (await countChunks(role.id)) === 0 ? 'empty' : '',
    );
    expect(remaining).toBe('empty');
  }, 30_000);

  it('poller detects a direct MinIO edit that bypassed the write hook', async () => {
    // Seed a shared-scope file straight into MinIO — no write hook fires.
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: `${COMPANY_SLUG}/knowledge/shared/policy.md`,
        Body: OKF('Company policy: be excellent.'),
        ContentType: 'text/markdown',
      }),
    );
    expect(await countChunks(null)).toBe(0);

    // Scope this poll cycle to our company to avoid touching other specs' data.
    jest.spyOn(companyRepo, 'find').mockResolvedValueOnce([company]);
    await reindex.poll();

    const chunks = await waitFor(async () =>
      (await countChunks(null)) > 0 ? await countChunks(null) : 0,
    );
    expect(chunks).toBeGreaterThan(0);
  }, 30_000);
});
