import { AuditEvent, LcpAgent, LcpCompany, LcpRole } from '@lcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../apps/lcp-server/src/app.module';
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
    // DELETE (not TRUNCATE) — PostgreSQL rejects TRUNCATE on FK-referenced tables
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
        .send({
          slug: 'acme',
          name: 'Acme Corp',
          description: 'A company that makes everything',
        })
        .expect(201);
    });

    it('returns 401 when no token is provided', async () => {
      await request(app.getHttpServer())
        .post('/api/company')
        .send({
          slug: 'acme',
          name: 'Acme Corp',
          description: 'A company that makes everything',
        })
        .expect(401);
    });
  });

  describe('POST /api/company (slug replacement)', () => {
    it('replaces an existing company with the same slug on a second POST', async () => {
      await request(app.getHttpServer())
        .post('/api/company')
        .set('Authorization', `Bearer ${jwt}`)
        .send({
          slug: 'acme',
          name: 'First',
          description: 'First company that makes everything',
        });

      await request(app.getHttpServer())
        .post('/api/company')
        .set('Authorization', `Bearer ${jwt}`)
        .send({
          slug: 'acme',
          name: 'Second',
          description: 'Second company that makes everything',
        });

      expect(await companyRepo.count({ where: { slug: 'acme' } })).toBe(1);
      expect((await companyRepo.findOneBy({ slug: 'acme' }))!.name).toBe(
        'Second',
      );
    });
  });

  describe('with a company', () => {
    let company: LcpCompany;

    // beforeEach (not beforeAll) because the outer afterEach deletes all records
    // after every it, so each test needs a fresh fixture.
    beforeEach(async () => {
      await request(app.getHttpServer())
        .post('/api/company')
        .set('Authorization', `Bearer ${jwt}`)
        .send({
          slug: 'acme',
          name: 'Acme Corp',
          description: 'A company that makes everything',
        });
      company = await companyRepo.findOneByOrFail({ slug: 'acme' });
    });

    describe('GET /api/company/:id', () => {
      it('returns the company by UUID', async () => {
        const res = await request(app.getHttpServer())
          .get(`/api/company/${company.id}`)
          .set('Authorization', `Bearer ${jwt}`)
          .expect(200);

        const body = res.body as { slug: string; name: string };
        expect(body.slug).toBe('acme');
        expect(body.name).toBe('Acme Corp');
      });

      it('returns the company by slug', async () => {
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
          .put(`/api/company/${company.id}`)
          .set('Authorization', `Bearer ${jwt}`)
          .send({ slug: 'acme', name: 'Updated' })
          .expect(200);

        expect((await companyRepo.findOneBy({ id: company.id }))!.name).toBe(
          'Updated',
        );
      });
    });
  });

  describe('with a company that has llmDefault', () => {
    let company: LcpCompany;

    beforeEach(async () => {
      await request(app.getHttpServer())
        .post('/api/company')
        .set('Authorization', `Bearer ${jwt}`)
        .send({
          slug: 'llm-co',
          name: 'LLM Co',
          description: 'LLM Company',
          llmDefault: { provider: 'openai', model: 'gpt-4o' },
        });
      company = await companyRepo.findOneByOrFail({ slug: 'llm-co' });
    });

    describe('with a role that inherits llmDefault', () => {
      beforeEach(async () => {
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
          });
      });

      describe('PUT /api/company/:id', () => {
        it('returns 400 when removing llmDefault would leave a role without any config', async () => {
          // Removing llmDefault must be rejected (null signals explicit removal)
          await request(app.getHttpServer())
            .put(`/api/company/${company.id}`)
            .set('Authorization', `Bearer ${jwt}`)
            .send({ slug: 'llm-co', name: 'LLM Co', llmDefault: null })
            .expect(400);
        });
      });
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

  describe('with a company', () => {
    let company: LcpCompany;

    beforeEach(async () => {
      await request(app.getHttpServer())
        .post('/api/company')
        .set('Authorization', `Bearer ${jwt}`)
        .send({
          slug: 'acme',
          name: 'Acme Corp',
          description: 'A company that makes everything',
        });
      company = await companyRepo.findOneByOrFail({ slug: 'acme' });
    });

    describe('POST /api/role', () => {
      it('returns 201 when role has explicit llmConfig', async () => {
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

      it('returns 400 when role has no llmConfig and company has no llmDefault', async () => {
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

  describe('with a company that has llmDefault', () => {
    let company: LcpCompany;

    beforeEach(async () => {
      await request(app.getHttpServer())
        .post('/api/company')
        .set('Authorization', `Bearer ${jwt}`)
        .send({
          slug: 'acme',
          name: 'Acme Corp',
          description: 'A company that makes everything',
          llmDefault: { provider: 'openai', model: 'gpt-4o' },
        });
      company = await companyRepo.findOneByOrFail({ slug: 'acme' });
    });

    describe('POST /api/role', () => {
      it('returns 201 when role has no llmConfig but company has llmDefault', async () => {
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
    });
  });
});
