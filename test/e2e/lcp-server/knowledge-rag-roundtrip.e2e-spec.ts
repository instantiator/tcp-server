import { TcpCompany, TcpRole } from '@tcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../../apps/lcp-server/src/app.module';
import { makeTestJwt } from '../helpers/test-jwt';
import { requireEnv } from '../../support/require-env';

const STUB_LLM_URL = requireEnv('STUB_LLM_URL');

/** Polls `fn` until it returns a truthy value, or throws once `timeoutMs` elapses. */
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

/**
 * Chains the whole knowledge pipeline together — upload, async reindex, and
 * retrieval — proving the pieces work as one system rather than in
 * isolation. `knowledge.e2e-spec.ts` already covers each endpoint standalone
 * (its `query` describe block seeds chunks directly via `RagIndexService`,
 * bypassing the write hook entirely); this spec is the one place that goes
 * through the real `POST .../knowledge` upload, waits on the real
 * `KnowledgeReindexService` write hook via the real `status` endpoint, and
 * only then queries — the same round trip a real client depends on.
 */
describe('knowledge RAG round trip (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<TcpCompany>;
  let roleRepo: Repository<TcpRole>;
  let roleId: UUID;

  const embeddingConfig = {
    provider: 'openai' as const,
    model: 'stub-embed',
    baseUrl: STUB_LLM_URL,
    apiKey: 'test',
  };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    companyRepo = module.get(getRepositoryToken(TcpCompany));
    roleRepo = module.get(getRepositoryToken(TcpRole));

    const company = await companyRepo.save(
      companyRepo.create({
        slug: `knowledge-roundtrip-co-${Date.now()}`,
        name: 'Knowledge Roundtrip Co',
        description: 'Test',
        embeddingConfig,
      }),
    );
    const role = await roleRepo.save(
      roleRepo.create({
        slug: 'roundtrip-writer',
        name: 'Roundtrip Writer',
        description: 'Test role',
        systemPromptTemplate: 'Write.',
        knowledgeDomains: [],
        mcpServerList: [],
        company,
        companyId: company.id,
      }),
    );
    roleId = role.id;
  });

  afterAll(async () => {
    await roleRepo.createQueryBuilder().delete().execute();
    await companyRepo.createQueryBuilder().delete().execute();
    await app.close();
  });

  it('a .txt upload is converted, indexed asynchronously, and becomes retrievable', async () => {
    const jwt = makeTestJwt();

    // A non-.md source exercises the format-aware conversion endpoint
    // (010.7.1) as well as the round trip — a plain .md upload would skip
    // that conversion step entirely.
    const storeRes = await request(app.getHttpServer())
      .post(`/api/role/${roleId}/knowledge`)
      .set('Authorization', `Bearer ${jwt}`)
      .attach(
        'file',
        Buffer.from('Remote employees must badge in via the VPN.'),
        'vpn-policy.txt',
      );
    expect(storeRes.status).toBe(201);

    // The write hook enqueues the reindex asynchronously (see
    // KnowledgeReindexService) — poll the real status endpoint (010.7.2)
    // rather than assuming a fixed delay.
    await waitFor(async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/role/${roleId}/knowledge/status`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      const status = res.body as { indexing: boolean; chunkCount: number };
      return !status.indexing && status.chunkCount > 0;
    });

    // stub-llm embeddings are deterministic-but-not-semantic, so an exact
    // content match is the only reliable way to get a high-similarity hit
    // — threshold -1 (the cosine floor) proves the pipeline end-to-end,
    // not ranking quality (see rag-retrieval-isolation.integration-spec.ts).
    const queryRes = await request(app.getHttpServer())
      .get(`/api/role/${roleId}/knowledge/query`)
      .query({
        q: 'Remote employees must badge in via the VPN.',
        threshold: -1,
      })
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);

    const chunks = queryRes.body as {
      documentPath: string;
      content: string;
    }[];
    expect(chunks.some((c) => c.documentPath.endsWith('vpn-policy.md'))).toBe(
      true,
    );
    expect(chunks.some((c) => c.content.includes('badge in via the VPN'))).toBe(
      true,
    );
  }, 30_000);
});
