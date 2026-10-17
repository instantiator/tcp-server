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
    // Listening, not just init() — see agent.e2e-spec.ts for why.
    await app.listen(0);
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

    it('returns 400 when timezone is not a valid IANA name', async () => {
      await request(app.getHttpServer())
        .post('/api/company')
        .set('Authorization', `Bearer ${jwt}`)
        .send({
          slug: 'acme',
          name: 'Acme Corp',
          description: 'A company that makes everything',
          timezone: 'Not/AZone',
        })
        .expect(400);
    });

    it('accepts a case-insensitive timezone, storing its canonical form', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/company')
        .set('Authorization', `Bearer ${jwt}`)
        .send({
          slug: 'acme',
          name: 'Acme Corp',
          description: 'A company that makes everything',
          timezone: 'europe/london',
        })
        .expect(201);

      expect((res.body as { timezone: string }).timezone).toBe('Europe/London');
    });
  });

  describe('POST /api/company (existing slug)', () => {
    /** Posts `acme` as the given caller, optionally asking to replace it. */
    const postAcme = (token: string, name: string, query = '') =>
      request(app.getHttpServer())
        .post(`/api/company${query}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ slug: 'acme', name, description: `${name} makes everything` });

    const acmeName = async () =>
      (await companyRepo.findOneByOrFail({ slug: 'acme' })).name;

    beforeEach(async () => {
      await postAcme(jwt, 'First').expect(201);
    });

    it('refuses an existing slug with 409 and leaves the company alone', async () => {
      const res = await postAcme(jwt, 'Second').expect(409);

      expect((res.body as { message: string }).message).toContain('acme');
      expect(await acmeName()).toBe('First');
    });

    it('treats any value but "true" as a plain create', async () => {
      await postAcme(jwt, 'Second', '?replace=1').expect(409);
      await postAcme(jwt, 'Second', '?replace').expect(409);

      expect(await acmeName()).toBe('First');
    });

    it('replaces the company for a member who asks to', async () => {
      await postAcme(jwt, 'Second', '?replace=true').expect(201);

      expect(await companyRepo.count({ where: { slug: 'acme' } })).toBe(1);
      expect(await acmeName()).toBe('Second');
    });

    it("refuses to replace another user's company with 403", async () => {
      const outsider = makeTestJwt({ sub: 'outsider' });

      await postAcme(outsider, 'Hijacked', '?replace=true').expect(403);

      expect(await acmeName()).toBe('First');
    });

    it('replaces the company for an administrator who is not a member', async () => {
      // Named in `.env.testing`'s TCP_ADMIN_IDENTIFIERS.
      const admin = makeTestJwt({ sub: 'e2e-admin' });

      await postAcme(admin, 'Second', '?replace=true').expect(201);

      expect(await acmeName()).toBe('Second');
    });

    it('creates a new slug with ?replace=true as an ordinary create', async () => {
      await request(app.getHttpServer())
        .post('/api/company?replace=true')
        .set('Authorization', `Bearer ${jwt}`)
        .send({ slug: 'fresh', name: 'Fresh', description: 'New' })
        .expect(201);
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

      // Was a 200 with an empty body (a null return serialised as `{}`), with
      // a TODO asking for this 404 before guarded endpoints shipped. 002.05
      // delivers it: the membership guard resolves the company before the
      // handler runs, so an id naming nothing is a 404 either way.
      it('returns 404 for an unknown UUID', () =>
        request(app.getHttpServer())
          .get('/api/company/00000000-0000-0000-0000-000000000000')
          .set('Authorization', `Bearer ${jwt}`)
          .expect(404));
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

      it('stores MCP server toggles, returns them, and clears them with null', async () => {
        await request(app.getHttpServer())
          .put(`/api/company/${company.id}`)
          .set('Authorization', `Bearer ${jwt}`)
          .send({ mcpServerToggles: { records: false, utilities: true } })
          .expect(200);
        const res = await request(app.getHttpServer())
          .get(`/api/company/${company.id}`)
          .set('Authorization', `Bearer ${jwt}`)
          .expect(200);
        expect(
          (res.body as { mcpServerToggles: unknown }).mcpServerToggles,
        ).toEqual({ records: false, utilities: true });

        await request(app.getHttpServer())
          .put(`/api/company/${company.id}`)
          .set('Authorization', `Bearer ${jwt}`)
          .send({ mcpServerToggles: null })
          .expect(200);
        expect(
          (await companyRepo.findOneBy({ id: company.id }))!.mcpServerToggles,
        ).toBeNull();
      });

      it('refuses a toggle for a server that does not exist', () =>
        request(app.getHttpServer())
          .put(`/api/company/${company.id}`)
          .set('Authorization', `Bearer ${jwt}`)
          .send({ mcpServerToggles: { recrods: false } })
          .expect(400));

      it('warns, but saves, when the tasks server is switched off', async () => {
        const res = await request(app.getHttpServer())
          .put(`/api/company/${company.id}`)
          .set('Authorization', `Bearer ${jwt}`)
          .send({ mcpServerToggles: { tasks: false } })
          .expect(200);
        const warnings = JSON.parse(res.headers['x-tcp-warnings']) as string[];
        expect(warnings.map(decodeURIComponent)).toContainEqual(
          expect.stringContaining('tasks MCP server is switched off'),
        );
      });
    });

    describe('PUT /api/company/:id clearing and the planner', () => {
      /** PUTs `body` to the fixture company and returns the stored row. */
      const put = async (body: object, status = 200) => {
        await request(app.getHttpServer())
          .put(`/api/company/${company.id}`)
          .set('Authorization', `Bearer ${jwt}`)
          .send(body)
          .expect(status);
        return companyRepo.findOneByOrFail({ id: company.id });
      };

      /** Creates a role in `companyId` and returns its id. */
      const createRole = async (companyId: string, slug: string) => {
        const res = await request(app.getHttpServer())
          .post('/api/role')
          .set('Authorization', `Bearer ${jwt}`)
          .send({
            companyId,
            slug,
            name: slug,
            description: 'Plans.',
            knowledgeDomains: [],
            mcpServerList: [],
          })
          .expect(201);
        return (res.body as TcpRole).id;
      };

      it.each(['companyContext', 'systemPromptTemplate', 'timezone'] as const)(
        'clears %s with null',
        async (field) => {
          const values = {
            companyContext: 'We make everything.',
            systemPromptTemplate: 'You are {{name}}.',
            timezone: 'Europe/London',
          };
          expect((await put({ [field]: values[field] }))[field]).toBe(
            values[field],
          );

          expect((await put({ [field]: null }))[field]).toBeNull();
        },
      );

      it('sets the planner to one of its roles and clears it with null', async () => {
        const roleId = await createRole(company.id, 'planner');

        expect((await put({ plannerRoleId: roleId })).plannerRoleId).toBe(
          roleId,
        );
        expect((await put({ plannerRoleId: null })).plannerRoleId).toBeNull();
      });

      it("refuses another company's role as the planner", async () => {
        const otherRes = await request(app.getHttpServer())
          .post('/api/company')
          .set('Authorization', `Bearer ${jwt}`)
          .send({ slug: 'other', name: 'Other', description: 'Other co' })
          .expect(201);
        const roleId = await createRole(
          (otherRes.body as TcpCompany).id,
          'outsider',
        );

        expect((await put({ plannerRoleId: roleId }, 400)).plannerRoleId).toBe(
          null,
        );
      });

      it('sets version retention, clears it with null, and refuses 0 and 3651', async () => {
        expect(
          (await put({ versionRetentionDays: 30 })).versionRetentionDays,
        ).toBe(30);
        await put({ versionRetentionDays: 0 }, 400);
        await put({ versionRetentionDays: 3651 }, 400);

        expect(
          (await put({ versionRetentionDays: null })).versionRetentionDays,
        ).toBeNull();
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

    describe('PUT /api/company/:id with null configs', () => {
      it('clears llmConfig', async () => {
        await request(app.getHttpServer())
          .put(`/api/company/${company.id}`)
          .set('Authorization', `Bearer ${jwt}`)
          .send({ llmConfig: null })
          .expect(200);

        const res = await request(app.getHttpServer())
          .get(`/api/company/${company.id}`)
          .set('Authorization', `Bearer ${jwt}`)
          .expect(200);
        expect((res.body as TcpCompany).llmConfig).toBeNull();
      });

      it('clears embeddingConfig', async () => {
        await request(app.getHttpServer())
          .put(`/api/company/${company.id}`)
          .set('Authorization', `Bearer ${jwt}`)
          .send({
            embeddingConfig: {
              provider: 'openai',
              model: 'text-embedding-3-small',
            },
          })
          .expect(200);
        await request(app.getHttpServer())
          .put(`/api/company/${company.id}`)
          .set('Authorization', `Bearer ${jwt}`)
          .send({ embeddingConfig: null })
          .expect(200);

        const res = await request(app.getHttpServer())
          .get(`/api/company/${company.id}`)
          .set('Authorization', `Bearer ${jwt}`)
          .expect(200);
        expect((res.body as TcpCompany).embeddingConfig).toBeNull();
      });
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
    await app.listen(0);
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

    // Was a 400 from the DTO's `@IsUUID`. Guards run before validation pipes,
    // so since 002.05 the membership guard answers first: a company handle is
    // UUID-or-slug, and `not-a-uuid` is simply a slug naming no company. Still
    // a loud, accurate refusal — a different 4xx.
    it('returns 404 when companyId is not a valid UUID', async () => {
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
        .expect(404);
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

      it("stores the role's MCP server toggles", async () => {
        await request(app.getHttpServer())
          .post('/api/role')
          .set('Authorization', `Bearer ${jwt}`)
          .send({
            companyId: company.id,
            slug: 'lean',
            name: 'lean',
            description: 'Runs without records.',
            systemPromptTemplate: 'You are {{name}}.',
            knowledgeDomains: [],
            mcpServerList: [],
            mcpServerToggles: { records: false },
          })
          .expect(201);
        expect(
          (await roleRepo.findOneByOrFail({ slug: 'lean' })).mcpServerToggles,
        ).toEqual({ records: false });
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

    describe('PUT /api/role/:id', () => {
      it("clears the role's own model with llmConfig: null, so it uses the company's", async () => {
        const created = await request(app.getHttpServer())
          .post('/api/role')
          .set('Authorization', `Bearer ${jwt}`)
          .send({
            companyId: company.id,
            slug: 'tuned',
            name: 'tuned',
            description: 'Has its own model.',
            llmConfig: { provider: 'lm-studio', model: 'qwen3-5b' },
            knowledgeDomains: [],
            mcpServerList: [],
          })
          .expect(201);
        const role = created.body as TcpRole;

        await request(app.getHttpServer())
          .put(`/api/role/${role.id}`)
          .set('Authorization', `Bearer ${jwt}`)
          .send({ llmConfig: null })
          .expect(200)
          .expect((res) => {
            expect((res.body as TcpRole).llmConfig).toBeNull();
          });
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
