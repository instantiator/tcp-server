import { CompanyUser, TcpCompany, TcpRole } from '@tcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../../apps/tcp-server/src/app.module';
import { KnowledgeService } from '../../../apps/tcp-server/src/api/knowledge.service';
import { makeTestJwt } from '../helpers/test-jwt';
import { seedMembership } from '../helpers/seed-membership';

describe('LLM model listing and embedding changes (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<TcpCompany>;
  let roleRepo: Repository<TcpRole>;
  let companyId: UUID;
  let otherRoleId: UUID;
  // A stand-in local model server, on a host .env.testing allows.
  let modelServer: Server;
  let baseUrl: string;
  let lastHeaders: IncomingHttpHeaders = {};
  const auth = () => `Bearer ${makeTestJwt()}`;

  beforeAll(async () => {
    modelServer = createServer((req, res) => {
      lastHeaders = req.headers;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'gemma' }, { id: 'qwen' }] }));
    });
    await new Promise<void>((resolve) =>
      modelServer.listen(0, '127.0.0.1', resolve),
    );
    baseUrl = `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`;

    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    // Listening, not just init() — see agent.e2e-spec.ts for why.
    await app.listen(0);
    companyRepo = module.get(getRepositoryToken(TcpCompany));
    roleRepo = module.get(getRepositoryToken(TcpRole));
    const companyUserRepo: Repository<CompanyUser> = module.get(
      getRepositoryToken(CompanyUser),
    );

    const company = await companyRepo.save(
      companyRepo.create({
        slug: `llm-models-co-${Date.now()}`,
        name: 'ModelsCo',
        description: 'Test',
        llmConfig: {
          provider: 'lm-studio',
          model: 'gemma',
          baseUrl,
          apiKey: 'saved-key',
        },
      }),
    );
    companyId = company.id;
    await seedMembership(companyUserRepo, company.id);

    const other = await companyRepo.save(
      companyRepo.create({
        slug: `llm-models-other-${Date.now()}`,
        name: 'OtherCo',
        description: 'Test',
      }),
    );
    const otherRole = await roleRepo.save(
      roleRepo.create({
        slug: 'other',
        name: 'Other',
        description: 'Test role',
        systemPromptTemplate: 'x',
        knowledgeDomains: [],
        mcpServerList: [],
        company: other,
        companyId: other.id,
      }),
    );
    otherRoleId = otherRole.id;
  });

  afterAll(async () => {
    await roleRepo.createQueryBuilder().delete().execute();
    await companyRepo.createQueryBuilder().delete().execute();
    await app.close();
    await new Promise((resolve) => modelServer.close(resolve));
  });

  describe('POST /api/company/:companyId/llm/models', () => {
    const path = () => `/api/company/${companyId}/llm/models`;

    it('returns 401 without a token', () =>
      request(app.getHttpServer()).post(path()).expect(401));

    it("lists the server's models, sending the company's saved key", async () => {
      await request(app.getHttpServer())
        .post(path())
        .set('Authorization', auth())
        .send({ provider: 'lm-studio', baseUrl })
        .expect(200)
        .expect(({ body }) =>
          expect(body).toEqual({ models: ['gemma', 'qwen'] }),
        );
      expect(lastHeaders.authorization).toBe('Bearer saved-key');
    });

    it('refuses a remote provider', () =>
      request(app.getHttpServer())
        .post(path())
        .set('Authorization', auth())
        .send({ provider: 'openai', baseUrl: 'https://api.openai.com/v1' })
        .expect(400));

    it("refuses another company's role as the key source", () =>
      request(app.getHttpServer())
        .post(path())
        .set('Authorization', auth())
        .send({ provider: 'lm-studio', baseUrl, roleId: otherRoleId })
        .expect(404));
  });

  describe('POST /api/llm/models (before a company exists)', () => {
    const path = '/api/llm/models';

    it('returns 401 without a token', () =>
      request(app.getHttpServer()).post(path).expect(401));

    it('lists for any signed-in user, sending no key unless one is typed', async () => {
      // Someone with no companies at all: the form they're filling in is
      // the one that creates their first.
      const stranger = `Bearer ${makeTestJwt({ sub: 'no-companies-yet' })}`;
      await request(app.getHttpServer())
        .post(path)
        .set('Authorization', stranger)
        .send({ provider: 'lm-studio', baseUrl, roleId: otherRoleId })
        .expect(200)
        .expect(({ body }) =>
          expect(body).toEqual({ models: ['gemma', 'qwen'] }),
        );
      expect(lastHeaders.authorization).toBeUndefined();

      await request(app.getHttpServer())
        .post(path)
        .set('Authorization', stranger)
        .send({ provider: 'lm-studio', baseUrl, apiKey: 'typed-key' })
        .expect(200);
      expect(lastHeaders.authorization).toBe('Bearer typed-key');
    });

    it('refuses a host the URL policy does not allow', () =>
      request(app.getHttpServer())
        .post(path)
        .set('Authorization', auth())
        .send({ provider: 'lm-studio', baseUrl: 'http://10.0.0.5:1234/v1' })
        .expect(400));
  });

  describe('PUT /api/company/:id with a new embedding model', () => {
    let reindex: jest.SpyInstance;
    const embedding = (model: string) => ({
      provider: 'lm-studio',
      model,
      baseUrl,
    });
    const put = (body: object) =>
      request(app.getHttpServer())
        .put(`/api/company/${companyId}`)
        .set('Authorization', auth())
        .send(body)
        .expect(200);

    beforeEach(() => {
      reindex = jest
        .spyOn(app.get(KnowledgeService), 'reindexCompany')
        .mockResolvedValue();
    });

    afterEach(() => reindex.mockRestore());

    it('re-indexes on a change, and not on the same model saved again', async () => {
      await put({ embeddingConfig: embedding('nomic') });
      expect(reindex).toHaveBeenCalledWith(companyId);

      reindex.mockClear();
      await put({ embeddingConfig: embedding('nomic') });
      expect(reindex).not.toHaveBeenCalled();
    });

    it('does not re-index for a change to something else', async () => {
      await put({ name: 'ModelsCo renamed' });
      expect(reindex).not.toHaveBeenCalled();
    });
  });
});
