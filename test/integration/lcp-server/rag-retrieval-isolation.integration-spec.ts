import {
  EmbeddingService,
  KnowledgeChunk,
  TcpCompany,
  TcpRole,
} from '@lcp/shared';
import { DataSource, Repository } from 'typeorm';
import { RagIndexService } from '../../../apps/lcp-server/src/rag/rag-index.service';
import { RagRetrievalService } from '../../../apps/lcp-server/src/rag/rag-retrieval.service';
import { requireEnv } from '../../support/require-env';

const DATABASE_URL = requireEnv('DATABASE_URL');
const STUB_LLM_URL = requireEnv('STUB_LLM_URL');

/**
 * Proves the row-level company/role isolation of {@link RagRetrievalService.retrieve}
 * against real seeded rows in Postgres, rather than just asserting the SQL string
 * (the unit-level coverage in rag-retrieval.service.spec.ts mocks the DataSource
 * entirely, so it can't catch a scoping regression that still produces valid SQL).
 *
 * Seeds three chunk groups — company A/role A (private), company A/shared, and
 * company B/role B (a different company+role entirely) — then asserts a query
 * scoped to role A returns the first two groups and never the third.
 *
 * Run via: ./scripts/run-integration-tests.sh
 */
describe('RagRetrievalService scoped-retrieval isolation (integration)', () => {
  let ds: DataSource;
  let companyRepo: Repository<TcpCompany>;
  let roleRepo: Repository<TcpRole>;
  let chunkRepo: Repository<KnowledgeChunk>;
  let index: RagIndexService;
  let retrieval: RagRetrievalService;

  let companyA: TcpCompany;
  let roleA: TcpRole;
  let companyB: TcpCompany;
  let roleB: TcpRole;

  const embeddingConfig = {
    provider: 'openai' as const,
    model: 'stub-embed',
    baseUrl: STUB_LLM_URL,
    apiKey: 'test',
  };

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      url: DATABASE_URL,
      entities: [TcpCompany, TcpRole, KnowledgeChunk],
      synchronize: true,
    });
    await ds.initialize();
    await ds.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await ds.query(
      `ALTER TABLE "knowledge_chunk" ADD COLUMN IF NOT EXISTS embedding vector(768)`,
    );

    companyRepo = ds.getRepository(TcpCompany);
    roleRepo = ds.getRepository(TcpRole);
    chunkRepo = ds.getRepository(KnowledgeChunk);

    const embedding = new EmbeddingService();
    index = new RagIndexService(embedding, chunkRepo, ds);
    retrieval = new RagRetrievalService(embedding, ds);

    companyA = await companyRepo.save(
      companyRepo.create({
        slug: 'rag-iso-co-a',
        name: 'Rag Isolation Co A',
        description: 'test',
        embeddingConfig,
      }),
    );
    roleA = await roleRepo.save(
      roleRepo.create({
        slug: 'analyst-a',
        name: 'Analyst A',
        description: 'test',
        systemPromptTemplate: 'x',
        knowledgeDomains: [],
        mcpServerList: [],
        company: companyA,
        companyId: companyA.id,
      }),
    );
    companyB = await companyRepo.save(
      companyRepo.create({
        slug: 'rag-iso-co-b',
        name: 'Rag Isolation Co B',
        description: 'test',
        embeddingConfig,
      }),
    );
    roleB = await roleRepo.save(
      roleRepo.create({
        slug: 'analyst-b',
        name: 'Analyst B',
        description: 'test',
        systemPromptTemplate: 'x',
        knowledgeDomains: [],
        mcpServerList: [],
        company: companyB,
        companyId: companyB.id,
      }),
    );

    await index.ingestDocument(
      companyA.id,
      roleA.id,
      `${companyA.slug}/knowledge/${roleA.slug}/private-a.md`,
      'Role A private knowledge about the isolation test.',
      embeddingConfig,
    );
    await index.ingestDocument(
      companyA.id,
      null,
      `${companyA.slug}/knowledge/shared/shared-a.md`,
      'Company A shared knowledge about the isolation test.',
      embeddingConfig,
    );
    await index.ingestDocument(
      companyB.id,
      roleB.id,
      `${companyB.slug}/knowledge/${roleB.slug}/private-b.md`,
      'Role B private knowledge about the isolation test.',
      embeddingConfig,
    );
  }, 60_000);

  afterAll(async () => {
    await chunkRepo.delete({ companyId: companyA.id });
    await chunkRepo.delete({ companyId: companyB.id });
    await roleRepo.delete({ id: roleA.id });
    await roleRepo.delete({ id: roleB.id });
    await companyRepo.delete({ id: companyA.id });
    await companyRepo.delete({ id: companyB.id });
    await ds.destroy();
  }, 30_000);

  it("returns role A's own chunks and company A's shared chunks, never company B's", async () => {
    // stub-llm embeddings are deterministic-but-not-semantic (see
    // apps/lcp-stub-llm/src/embeddings.ts), so cosine similarity between two
    // genuinely different strings is essentially random noise centred on 0
    // — a threshold of 0 is a coin flip, not a floor. -1 (the true cosine
    // floor) is what actually guarantees every scoped-in chunk passes,
    // proving scoping, not similarity ranking (matches the convention
    // already used in knowledge-rag-roundtrip.e2e-spec.ts and
    // knowledge.e2e-spec.ts's query tests).
    const results = await retrieval.retrieve(
      roleA.id,
      companyA.id,
      'isolation test',
      embeddingConfig,
      10,
      -1,
    );

    const paths = results.map((r) => r.documentPath);
    expect(paths).toContain(
      `${companyA.slug}/knowledge/${roleA.slug}/private-a.md`,
    );
    expect(paths).toContain(`${companyA.slug}/knowledge/shared/shared-a.md`);
    expect(paths).not.toContain(
      `${companyB.slug}/knowledge/${roleB.slug}/private-b.md`,
    );
  });

  it("never returns role A's or company A's chunks when scoped to role B", async () => {
    // -1 (the true cosine floor) — see the previous test's comment.
    const results = await retrieval.retrieve(
      roleB.id,
      companyB.id,
      'isolation test',
      embeddingConfig,
      10,
      -1,
    );

    const paths = results.map((r) => r.documentPath);
    expect(paths).toContain(
      `${companyB.slug}/knowledge/${roleB.slug}/private-b.md`,
    );
    expect(paths).not.toContain(
      `${companyA.slug}/knowledge/${roleA.slug}/private-a.md`,
    );
    expect(paths).not.toContain(
      `${companyA.slug}/knowledge/shared/shared-a.md`,
    );
  });
});
