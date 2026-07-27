import {
  AuditEvent,
  CompanyUser,
  TcpAgent,
  TcpCompany,
  TcpRole,
} from '@tcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../../apps/tcp-server/src/app.module';
import { makeTestJwt } from '../helpers/test-jwt';

describe('CompanyController (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<TcpCompany>;
  let roleRepo: Repository<TcpRole>;
  let agentRepo: Repository<TcpAgent>;
  let auditRepo: Repository<AuditEvent>;
  let companyUserRepo: Repository<CompanyUser>;
  let jwt: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    companyRepo = moduleFixture.get(getRepositoryToken(TcpCompany));
    roleRepo = moduleFixture.get(getRepositoryToken(TcpRole));
    agentRepo = moduleFixture.get(getRepositoryToken(TcpAgent));
    auditRepo = moduleFixture.get(getRepositoryToken(AuditEvent));
    companyUserRepo = moduleFixture.get(getRepositoryToken(CompanyUser));
    jwt = makeTestJwt();
  });

  afterEach(async () => {
    // DELETE (not TRUNCATE) — PostgreSQL rejects TRUNCATE on FK-referenced tables
    await auditRepo.createQueryBuilder().delete().execute();
    await agentRepo.createQueryBuilder().delete().execute();
    await roleRepo.createQueryBuilder().delete().execute();
    await companyUserRepo.createQueryBuilder().delete().execute();
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

    it('adds the requesting user (JWT sub) as a CompanyUser with memberType "creator"', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/company')
        .set('Authorization', `Bearer ${jwt}`)
        .send({
          slug: 'acme',
          name: 'Acme Corp',
          description: 'A company that makes everything',
        })
        .expect(201);
      const company = res.body as TcpCompany;

      const creator = await companyUserRepo.findOneBy({
        companyId: company.id,
        identifier: 'test-user',
      });
      expect(creator).not.toBeNull();
      expect(creator!.memberType).toBe('creator');
    });

    it('reports X-Tcp-Warnings when companyContext is blank', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/company')
        .set('Authorization', `Bearer ${jwt}`)
        .send({
          slug: 'acme',
          name: 'Acme Corp',
          description: 'A company that makes everything',
        })
        .expect(201);

      const warnings = JSON.parse(res.headers['x-tcp-warnings']) as string[];
      expect(warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('companyContext')]),
      );
    });

    it('omits X-Tcp-Warnings when companyContext is set', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/company')
        .set('Authorization', `Bearer ${jwt}`)
        .send({
          slug: 'acme',
          name: 'Acme Corp',
          description: 'A company that makes everything',
          companyContext: 'We build widgets.',
        })
        .expect(201);

      expect(res.headers['x-tcp-warnings']).toBeUndefined();
    });

    it('returns 400 when slug looks like a UUID (would confuse id-vs-slug resolution)', async () => {
      await request(app.getHttpServer())
        .post('/api/company')
        .set('Authorization', `Bearer ${jwt}`)
        .send({
          slug: '11111111-2222-3333-4444-555555555555',
          name: 'Acme Corp',
          description: 'A company that makes everything',
        })
        .expect(400);
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
    let company: TcpCompany;

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

    describe('DELETE /api/company/:id', () => {
      it('returns 204 and removes the company, cascading to its roles', async () => {
        await request(app.getHttpServer())
          .post('/api/role')
          .set('Authorization', `Bearer ${jwt}`)
          .send({
            companyId: company.id,
            slug: 'analyst',
            name: 'analyst',
            description: 'Analyses.',
            systemPromptTemplate: 'You are {{name}}.',
            knowledgeDomains: [],
            mcpServerList: [],
          })
          .expect(201);

        await request(app.getHttpServer())
          .delete(`/api/company/${company.id}`)
          .set('Authorization', `Bearer ${jwt}`)
          .expect(204);

        expect(await companyRepo.findOneBy({ id: company.id })).toBeNull();
        expect(await roleRepo.findOneBy({ companyId: company.id })).toBeNull();
      });

      it('deletes a company by slug', async () => {
        await request(app.getHttpServer())
          .delete('/api/company/acme')
          .set('Authorization', `Bearer ${jwt}`)
          .expect(204);

        expect(await companyRepo.findOneBy({ id: company.id })).toBeNull();
      });

      it('returns 404 for an unknown company', async () => {
        await request(app.getHttpServer())
          .delete('/api/company/00000000-0000-0000-0000-000000000000')
          .set('Authorization', `Bearer ${jwt}`)
          .expect(404);
      });
    });
  });

  describe('with a company that has llmConfig', () => {
    let company: TcpCompany;

    beforeEach(async () => {
      await request(app.getHttpServer())
        .post('/api/company')
        .set('Authorization', `Bearer ${jwt}`)
        .send({
          slug: 'llm-co',
          name: 'LLM Co',
          description: 'LLM Company',
          llmConfig: { provider: 'openai', model: 'gpt-4o' },
        });
      company = await companyRepo.findOneByOrFail({ slug: 'llm-co' });
    });

    describe('with a role that inherits llmConfig', () => {
      beforeEach(async () => {
        await request(app.getHttpServer())
          .post('/api/role')
          .set('Authorization', `Bearer ${jwt}`)
          .send({
            companyId: company.id,
            slug: 'inheritor',
            name: 'inheritor',
            description: 'Uses company default.',
            systemPromptTemplate: 'You are {{name}}.',
            knowledgeDomains: [],
            mcpServerList: [],
          });
      });

      describe('PUT /api/company/:id', () => {
        it('returns 200 when removing llmConfig even when roles have no llmConfig (env fallback covers)', async () => {
          // Removing llmConfig is now permitted — orphaned roles fall back to the
          // environment-level LLM config (LLM_PROVIDER / LLM_MODEL) at runtime.
          await request(app.getHttpServer())
            .put(`/api/company/${company.id}`)
            .set('Authorization', `Bearer ${jwt}`)
            .send({ slug: 'llm-co', name: 'LLM Co', llmConfig: null })
            .expect(200);
        });
      });
    });
  });
});

describe('RoleController (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<TcpCompany>;
  let roleRepo: Repository<TcpRole>;
  let agentRepo: Repository<TcpAgent>;
  let auditRepo: Repository<AuditEvent>;
  let jwt: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    companyRepo = moduleFixture.get(getRepositoryToken(TcpCompany));
    roleRepo = moduleFixture.get(getRepositoryToken(TcpRole));
    agentRepo = moduleFixture.get(getRepositoryToken(TcpAgent));
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

  describe('POST /api/role (no matching company)', () => {
    it('returns 404 when companyId is a valid UUID not in the database', async () => {
      await request(app.getHttpServer())
        .post('/api/role')
        .set('Authorization', `Bearer ${jwt}`)
        .send({
          companyId: '00000000-0000-0000-0000-000000000000',
          slug: 'orphan',
          name: 'orphan',
          description: 'No company.',
          llmConfig: { provider: 'lm-studio', model: 'qwen3-5b' },
          systemPromptTemplate: 'You are {{name}}.',
          knowledgeDomains: [],
          mcpServerList: [],
        })
        .expect(404);
    });

    it('returns 400 when companyId is not a valid UUID', async () => {
      await request(app.getHttpServer())
        .post('/api/role')
        .set('Authorization', `Bearer ${jwt}`)
        .send({
          companyId: 'not-a-uuid',
          slug: 'invalid',
          name: 'invalid',
          description: 'Bad companyId.',
          llmConfig: { provider: 'lm-studio', model: 'qwen3-5b' },
          systemPromptTemplate: 'You are {{name}}.',
          knowledgeDomains: [],
          mcpServerList: [],
        })
        .expect(400);
    });
  });

  describe('with a company', () => {
    let company: TcpCompany;

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
            slug: 'analyst',
            name: 'analyst',
            description: 'Analyses.',
            llmConfig: { provider: 'lm-studio', model: 'qwen3-5b' },
            systemPromptTemplate: 'You are {{name}}.',
            knowledgeDomains: [],
            mcpServerList: [],
          })
          .expect(201);
      });

      it('returns 201 when role has no llmConfig and company has no llmConfig (env fallback covers)', async () => {
        // The role can be created without any DB-level LLM config; the env fallback
        // (LLM_PROVIDER / LLM_MODEL) is checked at runtime when a message is sent.
        await request(app.getHttpServer())
          .post('/api/role')
          .set('Authorization', `Bearer ${jwt}`)
          .send({
            companyId: company.id,
            slug: 'env-reliant',
            name: 'env-reliant',
            description: 'Relies on env fallback.',
            systemPromptTemplate: 'You are {{name}}.',
            knowledgeDomains: [],
            mcpServerList: [],
          })
          .expect(201);
      });

      it('reports X-Tcp-Warnings when knowledgeDomains is empty and rolePrompt is blank', async () => {
        const res = await request(app.getHttpServer())
          .post('/api/role')
          .set('Authorization', `Bearer ${jwt}`)
          .send({
            companyId: company.id,
            slug: 'analyst',
            name: 'analyst',
            description: 'Analyses.',
            systemPromptTemplate: 'You are {{name}}.',
            knowledgeDomains: [],
            mcpServerList: [],
          })
          .expect(201);

        const warnings = JSON.parse(res.headers['x-tcp-warnings']) as string[];
        expect(warnings).toEqual(
          expect.arrayContaining([
            expect.stringContaining('knowledgeDomains'),
            expect.stringContaining('rolePrompt'),
          ]),
        );
      });

      it('returns 400 when slug looks like a UUID (would confuse id-vs-slug resolution)', async () => {
        await request(app.getHttpServer())
          .post('/api/role')
          .set('Authorization', `Bearer ${jwt}`)
          .send({
            companyId: company.id,
            slug: '11111111-2222-3333-4444-555555555555',
            name: 'analyst',
            description: 'Analyses.',
            systemPromptTemplate: 'You are {{name}}.',
            knowledgeDomains: [],
            mcpServerList: [],
          })
          .expect(400);
      });
    });

    describe('DELETE /api/role/:id', () => {
      it('returns 204 and removes the role', async () => {
        const created = await request(app.getHttpServer())
          .post('/api/role')
          .set('Authorization', `Bearer ${jwt}`)
          .send({
            companyId: company.id,
            slug: 'analyst',
            name: 'analyst',
            description: 'Analyses.',
            systemPromptTemplate: 'You are {{name}}.',
            knowledgeDomains: [],
            mcpServerList: [],
          })
          .expect(201);
        const role = created.body as TcpRole;

        await request(app.getHttpServer())
          .delete(`/api/role/${role.id}`)
          .set('Authorization', `Bearer ${jwt}`)
          .expect(204);

        expect(await roleRepo.findOneBy({ id: role.id })).toBeNull();
      });

      it('returns 404 for an unknown role', async () => {
        await request(app.getHttpServer())
          .delete('/api/role/00000000-0000-0000-0000-000000000000')
          .set('Authorization', `Bearer ${jwt}`)
          .expect(404);
      });
    });

    describe('DELETE /api/company/:companyId/roles/by-slug/:slug', () => {
      it('returns 204 and removes the role by slug', async () => {
        await request(app.getHttpServer())
          .post('/api/role')
          .set('Authorization', `Bearer ${jwt}`)
          .send({
            companyId: company.id,
            slug: 'analyst',
            name: 'analyst',
            description: 'Analyses.',
            systemPromptTemplate: 'You are {{name}}.',
            knowledgeDomains: [],
            mcpServerList: [],
          })
          .expect(201);

        await request(app.getHttpServer())
          .delete(`/api/company/${company.id}/roles/by-slug/analyst`)
          .set('Authorization', `Bearer ${jwt}`)
          .expect(204);

        expect(
          await roleRepo.findOneBy({ companyId: company.id, slug: 'analyst' }),
        ).toBeNull();
      });

      it('returns 404 for an unknown role slug', async () => {
        await request(app.getHttpServer())
          .delete(`/api/company/${company.id}/roles/by-slug/no-such-role`)
          .set('Authorization', `Bearer ${jwt}`)
          .expect(404);
      });
    });
  });

  describe('with a company that has llmConfig', () => {
    let company: TcpCompany;

    beforeEach(async () => {
      await request(app.getHttpServer())
        .post('/api/company')
        .set('Authorization', `Bearer ${jwt}`)
        .send({
          slug: 'acme',
          name: 'Acme Corp',
          description: 'A company that makes everything',
          llmConfig: { provider: 'openai', model: 'gpt-4o' },
        });
      company = await companyRepo.findOneByOrFail({ slug: 'acme' });
    });

    describe('POST /api/role', () => {
      it('returns 201 when role has no llmConfig but company has llmConfig', async () => {
        await request(app.getHttpServer())
          .post('/api/role')
          .set('Authorization', `Bearer ${jwt}`)
          .send({
            companyId: company.id,
            slug: 'inheritor',
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
