import { TcpCompany, TcpRole } from '@tcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../../apps/lcp-server/src/app.module';
import { makeTestJwt } from '../helpers/test-jwt';

/**
 * Proves write-time document validation (docs/prompts/009.4) actually gates
 * writes end-to-end, not just at the unit level — an invalid document must
 * never land in storage, and a valid one must succeed.
 *
 * `embeddingConfig` is deliberately left unset on the test company, so
 * `RagIndexService.ingestDocument` short-circuits before any embedding call
 * — asserting "no RAG ingestion happened" would be true regardless of
 * validation and wouldn't prove anything. Instead this proves gating via
 * the storage side: an invalid write is rejected (422) and never appears
 * via a follow-up read/list, while a valid write succeeds and is visible.
 */
describe('Storage write-time validation gating (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<TcpCompany>;
  let roleRepo: Repository<TcpRole>;
  let jwt: string;
  let company: TcpCompany;
  let role: TcpRole;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    companyRepo = moduleFixture.get(getRepositoryToken(TcpCompany));
    roleRepo = moduleFixture.get(getRepositoryToken(TcpRole));
    jwt = makeTestJwt();

    company = await companyRepo.save(
      companyRepo.create({
        slug: 'validation-gate-co',
        name: 'Validation Gate Co',
        description: 'test',
      }),
    );
    role = await roleRepo.save(
      roleRepo.create({
        companyId: company.id,
        slug: 'analyst',
        name: 'analyst',
        description: 'test',
      }),
    );
  });

  afterAll(async () => {
    await roleRepo.createQueryBuilder().delete().execute();
    await companyRepo.createQueryBuilder().delete().execute();
    await app.close();
  });

  describe('POST /api/storage (generic write)', () => {
    it('rejects invalid JSON with 422 and never writes the object', async () => {
      const path = `${company.slug}/tasks/x/bad.json`;

      const postRes = await request(app.getHttpServer())
        .post(`/api/storage?path=${encodeURIComponent(path)}`)
        .set('Authorization', `Bearer ${jwt}`)
        .attach('file', Buffer.from('{not valid json'), 'bad.json');

      expect(postRes.status).toBe(422);
      const body = postRes.body as { errors: { llmHint: string }[] };
      expect(body.errors[0].llmHint).toMatch(/not valid JSON/);

      const getRes = await request(app.getHttpServer())
        .get(`/api/storage?path=${encodeURIComponent(path)}`)
        .set('Authorization', `Bearer ${jwt}`);
      expect(getRes.status).toBe(404);
    });

    it('accepts valid JSON and stores it', async () => {
      const path = `${company.slug}/tasks/x/good.json`;

      const postRes = await request(app.getHttpServer())
        .post(`/api/storage?path=${encodeURIComponent(path)}`)
        .set('Authorization', `Bearer ${jwt}`)
        .attach('file', Buffer.from('{"a":1}'), 'good.json');
      expect(postRes.status).toBe(201);

      const getRes = await request(app.getHttpServer())
        .get(`/api/storage?path=${encodeURIComponent(path)}`)
        .set('Authorization', `Bearer ${jwt}`);
      expect(getRes.status).toBe(200);
      expect(getRes.text).toBe('{"a":1}');
    });
  });

  describe('POST /api/role/:roleId/knowledge', () => {
    it('rejects an OKF document missing front-matter with 422 and never lists it', async () => {
      const postRes = await request(app.getHttpServer())
        .post(`/api/role/${role.id}/knowledge`)
        .set('Authorization', `Bearer ${jwt}`)
        .attach('file', Buffer.from('# no front-matter'), 'bad.md');

      expect(postRes.status).toBe(422);

      const listRes = await request(app.getHttpServer())
        .get(`/api/role/${role.id}/knowledge`)
        .set('Authorization', `Bearer ${jwt}`);
      expect(listRes.status).toBe(200);
      expect(
        (listRes.body as { name: string }[]).some((d) => d.name === 'bad.md'),
      ).toBe(false);
    });

    it('accepts a valid OKF document and lists it', async () => {
      const content = '---\ntitle: Report\n---\n\nBody.';
      const postRes = await request(app.getHttpServer())
        .post(`/api/role/${role.id}/knowledge`)
        .set('Authorization', `Bearer ${jwt}`)
        .attach('file', Buffer.from(content), 'good.md');
      expect(postRes.status).toBe(201);

      const listRes = await request(app.getHttpServer())
        .get(`/api/role/${role.id}/knowledge`)
        .set('Authorization', `Bearer ${jwt}`);
      expect(
        (listRes.body as { name: string }[]).some((d) => d.name === 'good.md'),
      ).toBe(true);
    });
  });

  describe('POST /api/company/:companyId/knowledge', () => {
    it('rejects an OKF document missing front-matter with 422 and never lists it', async () => {
      const postRes = await request(app.getHttpServer())
        .post(`/api/company/${company.id}/knowledge`)
        .set('Authorization', `Bearer ${jwt}`)
        .attach('file', Buffer.from('# no front-matter'), 'bad.md');

      expect(postRes.status).toBe(422);

      const listRes = await request(app.getHttpServer())
        .get(`/api/company/${company.id}/knowledge`)
        .set('Authorization', `Bearer ${jwt}`);
      expect(listRes.status).toBe(200);
      expect(
        (listRes.body as { name: string }[]).some((d) => d.name === 'bad.md'),
      ).toBe(false);
    });

    it('accepts a valid OKF document and lists it', async () => {
      const content = '---\ntitle: Policy\n---\n\nBody.';
      const postRes = await request(app.getHttpServer())
        .post(`/api/company/${company.id}/knowledge`)
        .set('Authorization', `Bearer ${jwt}`)
        .attach('file', Buffer.from(content), 'good-shared.md');
      expect(postRes.status).toBe(201);

      const listRes = await request(app.getHttpServer())
        .get(`/api/company/${company.id}/knowledge`)
        .set('Authorization', `Bearer ${jwt}`);
      expect(
        (listRes.body as { name: string }[]).some(
          (d) => d.name === 'good-shared.md',
        ),
      ).toBe(true);
    });
  });
});
