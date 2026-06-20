import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AuditEvent, LcpAgent, LcpCompany, LcpRole } from '@lcp/shared';
import { AppModule } from '../src/app.module';
import { makeTestJwt } from './helpers/test-jwt';

describe('CompanyController (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<LcpCompany>;
  let roleRepo: Repository<LcpRole>;
  let agentRepo: Repository<LcpAgent>;
  let auditRepo: Repository<AuditEvent>;
  let jwt: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    companyRepo = moduleFixture.get(getRepositoryToken(LcpCompany));
    roleRepo = moduleFixture.get(getRepositoryToken(LcpRole));
    agentRepo = moduleFixture.get(getRepositoryToken(LcpAgent));
    auditRepo = moduleFixture.get(getRepositoryToken(AuditEvent));
    jwt = makeTestJwt();
  });

  afterEach(async () => {
    // DELETE (not clear/TRUNCATE) — PostgreSQL rejects TRUNCATE on FK-referenced tables
    await auditRepo.createQueryBuilder().delete().execute();
    await agentRepo.createQueryBuilder().delete().execute();
    await roleRepo.createQueryBuilder().delete().execute();
    await companyRepo.createQueryBuilder().delete().execute();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /api/company', () => {
    it('returns 201 when creating a company', async () => {
      await request(app.getHttpServer())
        .post('/api/company')
        .set('Authorization', `Bearer ${jwt}`)
        .send({ slug: 'acme', name: 'Acme Corp' })
        .expect(201);
    });

    it('persists the company so it can be retrieved', async () => {
      await request(app.getHttpServer())
        .post('/api/company')
        .set('Authorization', `Bearer ${jwt}`)
        .send({ slug: 'acme', name: 'Acme Corp' });

      const record = await companyRepo.findOneBy({ slug: 'acme' });
      expect(record).not.toBeNull();
      expect(record!.name).toBe('Acme Corp');
    });

    it('replaces an existing company with the same slug on a second POST', async () => {
      await request(app.getHttpServer())
        .post('/api/company')
        .set('Authorization', `Bearer ${jwt}`)
        .send({ slug: 'acme', name: 'First' });

      await request(app.getHttpServer())
        .post('/api/company')
        .set('Authorization', `Bearer ${jwt}`)
        .send({ slug: 'acme', name: 'Second' });

      expect(await companyRepo.count({ where: { slug: 'acme' } })).toBe(1);
      expect((await companyRepo.findOneBy({ slug: 'acme' }))!.name).toBe(
        'Second',
      );
    });

    it('returns 401 when no token is provided', async () => {
      await request(app.getHttpServer())
        .post('/api/company')
        .send({ slug: 'acme', name: 'Acme Corp' })
        .expect(401);
    });
  });

  describe('GET /api/company/:id', () => {
    it('returns 200 with the company when found by UUID', async () => {
      await request(app.getHttpServer())
        .post('/api/company')
        .set('Authorization', `Bearer ${jwt}`)
        .send({ slug: 'acme', name: 'Acme Corp' });

      const id = (await companyRepo.findOneBy({ slug: 'acme' }))!.id;

      const res = await request(app.getHttpServer())
        .get(`/api/company/${id}`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);

      const body = res.body as { slug: string; name: string };
      expect(body.slug).toBe('acme');
      expect(body.name).toBe('Acme Corp');
    });

    it('returns 200 with the company when found by slug', async () => {
      await request(app.getHttpServer())
        .post('/api/company')
        .set('Authorization', `Bearer ${jwt}`)
        .send({ slug: 'acme', name: 'Acme Corp' });

      const res = await request(app.getHttpServer())
        .get('/api/company/acme')
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);

      expect((res.body as { slug: string }).slug).toBe('acme');
    });

    it('returns 200 with empty body for an unknown UUID', async () => {
      // NestJS serialises a null return as {} rather than null.
      // TODO: add a NotFoundException guard to return 404 instead — before guarded endpoints are shipped, to align with REST conventions.
      const res = await request(app.getHttpServer())
        .get('/api/company/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);

      expect(res.body).toEqual({});
    });
  });

  describe('PUT /api/company/:id', () => {
    it('updates the company name', async () => {
      await request(app.getHttpServer())
        .post('/api/company')
        .set('Authorization', `Bearer ${jwt}`)
        .send({ slug: 'acme', name: 'Original' });

      const id = (await companyRepo.findOneBy({ slug: 'acme' }))!.id;

      await request(app.getHttpServer())
        .put(`/api/company/${id}`)
        .set('Authorization', `Bearer ${jwt}`)
        .send({ slug: 'acme', name: 'Updated' })
        .expect(200);

      expect((await companyRepo.findOneBy({ id }))!.name).toBe('Updated');
    });

    it('returns 400 when removing llmDefault would leave a role without any config', async () => {
      // Create company with llmDefault
      await request(app.getHttpServer())
        .post('/api/company')
        .set('Authorization', `Bearer ${jwt}`)
        .send({
          slug: 'llm-co',
          name: 'LLM Co',
          llmDefault: { provider: 'openai', model: 'gpt-4o' },
        });

      const id = (await companyRepo.findOneBy({ slug: 'llm-co' }))!.id;

      // Create a role with no llmConfig — relying on the company default
      await request(app.getHttpServer())
        .post('/api/role')
        .set('Authorization', `Bearer ${jwt}`)
        .send({
          companyId: id,
          name: 'inheritor',
          description: 'Uses company default.',
          systemPromptTemplate: 'You are {{name}}.',
          knowledgeDomains: [],
          mcpServerList: [],
        });

      // Removing llmDefault must be rejected (null signals explicit removal)
      await request(app.getHttpServer())
        .put(`/api/company/${id}`)
        .set('Authorization', `Bearer ${jwt}`)
        .send({ slug: 'llm-co', name: 'LLM Co', llmDefault: null })
        .expect(400);
    });
  });
});

describe('RoleController (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<LcpCompany>;
  let roleRepo: Repository<LcpRole>;
  let agentRepo: Repository<LcpAgent>;
  let auditRepo: Repository<AuditEvent>;
  let jwt: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    companyRepo = moduleFixture.get(getRepositoryToken(LcpCompany));
    roleRepo = moduleFixture.get(getRepositoryToken(LcpRole));
    agentRepo = moduleFixture.get(getRepositoryToken(LcpAgent));
    auditRepo = moduleFixture.get(getRepositoryToken(AuditEvent));
    jwt = makeTestJwt();
  });

  afterEach(async () => {
    await auditRepo.createQueryBuilder().delete().execute();
    await agentRepo.createQueryBuilder().delete().execute();
    await roleRepo.createQueryBuilder().delete().execute();
    await companyRepo.createQueryBuilder().delete().execute();
  });

  afterAll(async () => {
    await app.close();
  });

  async function createCompany(overrides: Record<string, unknown> = {}) {
    await request(app.getHttpServer())
      .post('/api/company')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ slug: 'acme', name: 'Acme Corp', ...overrides });
    return companyRepo.findOneByOrFail({ slug: 'acme' });
  }

  describe('POST /api/role', () => {
    it('returns 201 when role has explicit llmConfig', async () => {
      const company = await createCompany();
      await request(app.getHttpServer())
        .post('/api/role')
        .set('Authorization', `Bearer ${jwt}`)
        .send({
          companyId: company.id,
          name: 'analyst',
          description: 'Analyses.',
          llmConfig: { provider: 'lm-studio', model: 'qwen3-5b' },
          systemPromptTemplate: 'You are {{name}}.',
          knowledgeDomains: [],
          mcpServerList: [],
        })
        .expect(201);
    });

    it('returns 201 when role has no llmConfig but company has llmDefault', async () => {
      const company = await createCompany({
        llmDefault: { provider: 'openai', model: 'gpt-4o' },
      });
      await request(app.getHttpServer())
        .post('/api/role')
        .set('Authorization', `Bearer ${jwt}`)
        .send({
          companyId: company.id,
          name: 'inheritor',
          description: 'Uses company default.',
          systemPromptTemplate: 'You are {{name}}.',
          knowledgeDomains: [],
          mcpServerList: [],
        })
        .expect(201);
    });

    it('returns 400 when role has no llmConfig and company has no llmDefault', async () => {
      const company = await createCompany();
      await request(app.getHttpServer())
        .post('/api/role')
        .set('Authorization', `Bearer ${jwt}`)
        .send({
          companyId: company.id,
          name: 'broken',
          description: 'No config anywhere.',
          systemPromptTemplate: 'You are {{name}}.',
          knowledgeDomains: [],
          mcpServerList: [],
        })
        .expect(400);
    });
  });
});
