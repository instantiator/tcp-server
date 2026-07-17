import { AuditEvent, LcpAgent, LcpCompany, LcpRole } from '@lcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../../apps/lcp-server/src/app.module';
import { makeTestJwt } from '../helpers/test-jwt';

describe('KnowledgeController (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<LcpCompany>;
  let roleRepo: Repository<LcpRole>;
  let agentRepo: Repository<LcpAgent>;
  let auditRepo: Repository<AuditEvent>;
  let roleId: string;
  let companyId: string;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    companyRepo = module.get(getRepositoryToken(LcpCompany));
    roleRepo = module.get(getRepositoryToken(LcpRole));
    agentRepo = module.get(getRepositoryToken(LcpAgent));
    auditRepo = module.get(getRepositoryToken(AuditEvent));
    const company = await companyRepo.save(
      companyRepo.create({
        slug: 'knowledge-co',
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
});
