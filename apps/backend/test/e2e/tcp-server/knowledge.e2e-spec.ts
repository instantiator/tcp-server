import { AuditEvent, TcpAgent, TcpCompany, TcpRole } from '@tcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../../apps/tcp-server/src/app.module';
import { RagIndexService } from '../../../apps/tcp-server/src/rag/rag-index.service';
import { makeTestJwt } from '../helpers/test-jwt';
import { requireEnv } from '../../support/require-env';

const STUB_LLM_URL = requireEnv('STUB_LLM_URL');

describe('KnowledgeController (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<TcpCompany>;
  let roleRepo: Repository<TcpRole>;
  let agentRepo: Repository<TcpAgent>;
  let auditRepo: Repository<AuditEvent>;
  let ragIndex: RagIndexService;
  let roleId: UUID;
  let companyId: UUID;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    companyRepo = module.get(getRepositoryToken(TcpCompany));
    roleRepo = module.get(getRepositoryToken(TcpRole));
    agentRepo = module.get(getRepositoryToken(TcpAgent));
    auditRepo = module.get(getRepositoryToken(AuditEvent));
    ragIndex = module.get(RagIndexService);
    const company = await companyRepo.save(
      companyRepo.create({
        slug: `knowledge-co-${Date.now()}`,
        name: 'KnowledgeCo',
        description: 'Test',
      }),
    );
    companyId = company.id;
    const role = await roleRepo.save(
      roleRepo.create({
        slug: 'writer',
        name: 'Writer',
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

  afterEach(async () => {
    await auditRepo.createQueryBuilder().delete().execute();
    await agentRepo.createQueryBuilder().delete().execute();
  });

  afterAll(async () => {
    await roleRepo.createQueryBuilder().delete().execute();
    await companyRepo.createQueryBuilder().delete().execute();
    await app.close();
  });

  describe('role scope round-trip', () => {
    it('stores, lists, gets, and deletes a document (delete is idempotent)', async () => {
      const jwt = makeTestJwt();
      const content = '---\ntitle: Report\n---\n\nBody.';

      const storeRes = await request(app.getHttpServer())
        .post(`/api/role/${roleId}/knowledge`)
        .set('Authorization', `Bearer ${jwt}`)
        .attach('file', Buffer.from(content), 'report.md');
      expect(storeRes.status).toBe(201);

      const listRes = await request(app.getHttpServer())
        .get(`/api/role/${roleId}/knowledge`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      expect(
        (listRes.body as { name: string }[]).some(
          (d) => d.name === 'report.md',
        ),
      ).toBe(true);

      const getRes = await request(app.getHttpServer())
        .get(`/api/role/${roleId}/knowledge/report.md`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      expect(getRes.text).toBe(content);

      await request(app.getHttpServer())
        .delete(`/api/role/${roleId}/knowledge/report.md`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(204);

      await request(app.getHttpServer())
        .get(`/api/role/${roleId}/knowledge/report.md`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(404);

      // Deleting an already-deleted (or never-existing) file is a no-op, not an error.
      await request(app.getHttpServer())
        .delete(`/api/role/${roleId}/knowledge/report.md`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(204);
    });

    it('overwrites a document stored twice under the same filename', async () => {
      const jwt = makeTestJwt();
      await request(app.getHttpServer())
        .post(`/api/role/${roleId}/knowledge`)
        .set('Authorization', `Bearer ${jwt}`)
        .attach(
          'file',
          Buffer.from('---\ntitle: v1\n---\n\nFirst.'),
          'versioned.md',
        )
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/role/${roleId}/knowledge`)
        .set('Authorization', `Bearer ${jwt}`)
        .attach(
          'file',
          Buffer.from('---\ntitle: v2\n---\n\nSecond.'),
          'versioned.md',
        )
        .expect(201);

      const getRes = await request(app.getHttpServer())
        .get(`/api/role/${roleId}/knowledge/versioned.md`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      expect(getRes.text).toBe('---\ntitle: v2\n---\n\nSecond.');

      await request(app.getHttpServer())
        .delete(`/api/role/${roleId}/knowledge/versioned.md`)
        .set('Authorization', `Bearer ${jwt}`);
    });

    it('stores an upload under the body `filename` override, not the multipart filename', async () => {
      const jwt = makeTestJwt();
      const content = '---\ntitle: Overridden\n---\n\nBody.';

      await request(app.getHttpServer())
        .post(`/api/role/${roleId}/knowledge`)
        .set('Authorization', `Bearer ${jwt}`)
        .field('filename', 'y.md')
        .attach('file', Buffer.from(content), 'x.md')
        .expect(201);

      const getRes = await request(app.getHttpServer())
        .get(`/api/role/${roleId}/knowledge/y.md`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      expect(getRes.text).toBe(content);

      await request(app.getHttpServer())
        .get(`/api/role/${roleId}/knowledge/x.md`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(404);

      await request(app.getHttpServer())
        .delete(`/api/role/${roleId}/knowledge/y.md`)
        .set('Authorization', `Bearer ${jwt}`);
    });

    it('404s getting an unknown file, and 404s on an unknown role entirely', async () => {
      const jwt = makeTestJwt();
      await request(app.getHttpServer())
        .get(`/api/role/${roleId}/knowledge/does-not-exist.md`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(404);

      const unknownRoleId = '00000000-0000-0000-0000-000000000000';
      await request(app.getHttpServer())
        .get(`/api/role/${unknownRoleId}/knowledge`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(404);
    });
  });

  describe('company scope round-trip', () => {
    it('stores, lists, gets, and deletes a shared document', async () => {
      const jwt = makeTestJwt();
      const content = '---\ntitle: Policy\n---\n\nBe excellent.';

      await request(app.getHttpServer())
        .post(`/api/company/${companyId}/knowledge`)
        .set('Authorization', `Bearer ${jwt}`)
        .attach('file', Buffer.from(content), 'policy.md')
        .expect(201);

      const listRes = await request(app.getHttpServer())
        .get(`/api/company/${companyId}/knowledge`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      expect(
        (listRes.body as { name: string }[]).some(
          (d) => d.name === 'policy.md',
        ),
      ).toBe(true);

      const getRes = await request(app.getHttpServer())
        .get(`/api/company/${companyId}/knowledge/policy.md`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      expect(getRes.text).toBe(content);

      await request(app.getHttpServer())
        .delete(`/api/company/${companyId}/knowledge/policy.md`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(204);
    });

    it('404s for an unknown company', async () => {
      const jwt = makeTestJwt();
      await request(app.getHttpServer())
        .get(`/api/company/no-such-company/knowledge`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(404);
    });
  });

  describe('role scope', () => {
    it('GET /api/role/:roleId/knowledge returns 401 without a token', () =>
      request(app.getHttpServer())
        .get(`/api/role/${roleId}/knowledge`)
        .expect(401));

    it('GET /api/role/:roleId/knowledge/:filename returns 401 without a token', () =>
      request(app.getHttpServer())
        .get(`/api/role/${roleId}/knowledge/report.md`)
        .expect(401));

    it('POST /api/role/:roleId/knowledge returns 401 without a token', () =>
      request(app.getHttpServer())
        .post(`/api/role/${roleId}/knowledge`)
        .expect(401));

    it('DELETE /api/role/:roleId/knowledge/:filename returns 401 without a token', () =>
      request(app.getHttpServer())
        .delete(`/api/role/${roleId}/knowledge/report.md`)
        .expect(401));
  });

  describe('company scope', () => {
    it('GET /api/company/:companyId/knowledge returns 401 without a token', () =>
      request(app.getHttpServer())
        .get(`/api/company/${companyId}/knowledge`)
        .expect(401));

    // Seen fail intermittently (~1/5 full e2e runs, 2026-07-20): expected 401,
    // got 404. Not reproducible in isolation or in a targeted rerun alongside
    // agent-loop-interactions.e2e-spec.ts (the newest e2e spec at the time,
    // and the only one to bind a real port / start a real BullMQ worker) — so
    // ruled out as caused by that spec. No code-level link found to any
    // other change either. Likely host/Docker resource-contention flake, not
    // a logic bug. If it recurs, worth checking Postgres connection-pool
    // pressure across the full e2e run rather than re-guessing from here.
    it('GET /api/company/:companyId/knowledge/:filename returns 401 without a token', () =>
      request(app.getHttpServer())
        .get(`/api/company/${companyId}/knowledge/policy.md`)
        .expect(401));

    it('POST /api/company/:companyId/knowledge returns 401 without a token', () =>
      request(app.getHttpServer())
        .post(`/api/company/${companyId}/knowledge`)
        .expect(401));

    it('DELETE /api/company/:companyId/knowledge/:filename returns 401 without a token', () =>
      request(app.getHttpServer())
        .delete(`/api/company/${companyId}/knowledge/policy.md`)
        .expect(401));
  });

  describe('reindex', () => {
    it('POST /api/company/:companyId/knowledge/reindex returns 401 without a token', () =>
      request(app.getHttpServer())
        .post(`/api/company/${companyId}/knowledge/reindex`)
        .expect(401));

    it('POST /api/company/:companyId/knowledge/reindex returns 202 for a known company', () =>
      request(app.getHttpServer())
        .post(`/api/company/${companyId}/knowledge/reindex`)
        .set('Authorization', `Bearer ${makeTestJwt()}`)
        .expect(202)
        .expect((res) => {
          expect(res.body).toEqual({ reindexing: true });
        }));

    it('POST /api/company/:companyId/knowledge/reindex returns 404 for an unknown company', () =>
      request(app.getHttpServer())
        .post(`/api/company/no-such-company/knowledge/reindex`)
        .set('Authorization', `Bearer ${makeTestJwt()}`)
        .expect(404));
  });

  describe('status', () => {
    // A fresh role, scoped to this block: the outer `roleId`'s knowledge
    // scope has already been bumped repeatedly by earlier describe blocks'
    // writes, so its generation/counts aren't deterministic here.
    let statusRoleId: string;

    beforeAll(async () => {
      const company = await companyRepo.findOneByOrFail({ id: companyId });
      const role = await roleRepo.save(
        roleRepo.create({
          slug: 'status-checker',
          name: 'Status Checker',
          description: 'Test role for status checks',
          systemPromptTemplate: 'Check.',
          knowledgeDomains: [],
          mcpServerList: [],
          company,
          companyId: company.id,
        }),
      );
      statusRoleId = role.id;
    });

    it('GET /api/role/:roleId/knowledge/status returns counts for an empty scope', () =>
      request(app.getHttpServer())
        .get(`/api/role/${statusRoleId}/knowledge/status`)
        .set('Authorization', `Bearer ${makeTestJwt()}`)
        .expect(200)
        .expect((res) => {
          expect(res.body).toEqual({
            documentCount: 0,
            totalBytes: 0,
            chunkCount: 0,
            generation: 0,
            lastIndexedAt: null,
            indexing: false,
            lastError: null,
            lastErrorAt: null,
          });
        }));

    it('GET /api/company/:companyId/knowledge/status returns shared + every role', () =>
      request(app.getHttpServer())
        .get(`/api/company/${companyId}/knowledge/status`)
        .set('Authorization', `Bearer ${makeTestJwt()}`)
        .expect(200)
        .expect((res) => {
          const body = res.body as {
            shared: { documentCount: number };
            roles: { roleId: string; roleSlug: string }[];
          };
          expect(body.shared).toMatchObject({ documentCount: 0 });
          expect(body.roles).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                roleId: statusRoleId,
                roleSlug: 'status-checker',
              }),
            ]),
          );
        }));

    it('GET /api/role/:roleId/knowledge/status returns 404 for an unknown role', () =>
      request(app.getHttpServer())
        .get(`/api/role/00000000-0000-0000-0000-000000000000/knowledge/status`)
        .set('Authorization', `Bearer ${makeTestJwt()}`)
        .expect(404));

    it('GET /api/company/:companyId/knowledge/status returns 404 for an unknown company', () =>
      request(app.getHttpServer())
        .get(`/api/company/no-such-company/knowledge/status`)
        .set('Authorization', `Bearer ${makeTestJwt()}`)
        .expect(404));

    it('GET /api/role/:roleId/knowledge/status returns 401 without a token', () =>
      request(app.getHttpServer())
        .get(`/api/role/${roleId}/knowledge/status`)
        .expect(401));

    it('GET /api/company/:companyId/knowledge/status returns 401 without a token', () =>
      request(app.getHttpServer())
        .get(`/api/company/${companyId}/knowledge/status`)
        .expect(401));
  });

  describe('query', () => {
    // Own company (with an embeddingConfig pointed at the stub-llm) + role,
    // seeded with real chunks via RagIndexService — the outer company has no
    // embeddingConfig, so `retrieve` would silently return [] for it.
    const embeddingConfig = {
      provider: 'openai' as const,
      model: 'stub-embed',
      baseUrl: STUB_LLM_URL,
      apiKey: 'test',
    };
    let queryRoleId: UUID;

    beforeAll(async () => {
      const company = await companyRepo.save(
        companyRepo.create({
          slug: `knowledge-query-co-${Date.now()}`,
          name: 'KnowledgeQueryCo',
          description: 'Test',
          embeddingConfig,
        }),
      );
      const role = await roleRepo.save(
        roleRepo.create({
          slug: 'query-writer',
          name: 'Query Writer',
          description: 'Test role',
          systemPromptTemplate: 'Write.',
          knowledgeDomains: [],
          mcpServerList: [],
          company,
          companyId: company.id,
        }),
      );
      queryRoleId = role.id;

      await ragIndex.ingestDocument(
        company.id,
        role.id,
        `${company.slug}/knowledge/${role.slug}/remote-work.md`,
        'Employees may work remotely up to three days per week.',
        embeddingConfig,
      );
      await ragIndex.ingestDocument(
        company.id,
        null,
        `${company.slug}/knowledge/shared/handbook.md`,
        'All customer data must be encrypted at rest and in transit.',
        embeddingConfig,
      );
    }, 30_000);

    it('GET /api/role/:roleId/knowledge/query returns the role chunk and the shared chunk', () =>
      request(app.getHttpServer())
        .get(`/api/role/${queryRoleId}/knowledge/query`)
        // stub-llm embeddings are deterministic-but-not-semantic (see
        // apps/tcp-stub-llm/src/embeddings.ts), so similarity to an unrelated
        // query string is unpredictable — threshold -1 (the cosine floor)
        // proves scoping/plumbing, not ranking quality.
        .query({ q: 'remote work policy', threshold: -1 })
        .set('Authorization', `Bearer ${makeTestJwt()}`)
        .expect(200)
        .expect((res) => {
          const chunks = res.body as { documentPath: string }[];
          const paths = chunks.map((c) => c.documentPath);
          expect(paths.some((p) => p.endsWith('remote-work.md'))).toBe(true);
          expect(paths.some((p) => p.endsWith('handbook.md'))).toBe(true);
        }));

    it('returns 400 when q is missing', () =>
      request(app.getHttpServer())
        .get(`/api/role/${queryRoleId}/knowledge/query`)
        .set('Authorization', `Bearer ${makeTestJwt()}`)
        .expect(400));

    it('returns 404 for an unknown role', () =>
      request(app.getHttpServer())
        .get(`/api/role/00000000-0000-0000-0000-000000000000/knowledge/query`)
        .query({ q: 'remote work policy' })
        .set('Authorization', `Bearer ${makeTestJwt()}`)
        .expect(404));

    it('returns an empty array (not an error) when the company has no embeddingConfig', () =>
      request(app.getHttpServer())
        .get(`/api/role/${roleId}/knowledge/query`)
        .query({ q: 'remote work policy' })
        .set('Authorization', `Bearer ${makeTestJwt()}`)
        .expect(200)
        .expect((res) => {
          expect(res.body).toEqual([]);
        }));

    it('returns 401 without a token', () =>
      request(app.getHttpServer())
        .get(`/api/role/${queryRoleId}/knowledge/query`)
        .query({ q: 'remote work policy' })
        .expect(401));
  });
});
