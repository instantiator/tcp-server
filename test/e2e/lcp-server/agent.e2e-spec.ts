import { AuditEvent, LcpAgent, LcpCompany, LcpRole } from '@lcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../../apps/lcp-server/src/app.module';
import { makeTestJwt } from '../helpers/test-jwt';

describe('AgentController (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<LcpCompany>;
  let roleRepo: Repository<LcpRole>;
  let agentRepo: Repository<LcpAgent>;
  let auditRepo: Repository<AuditEvent>;
  let jwt: string;
  let companyId: string;
  let roleId: string;

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
    jwt = makeTestJwt();

    const company = await companyRepo.save(
      companyRepo.create({
        slug: 'acme',
        name: 'Acme',
        description: 'Test company',
      }),
    );
    companyId = company.id;
    const role = await roleRepo.save(
      roleRepo.create({
        name: 'Engineer',
        description: 'Test role',
        systemPromptTemplate: 'You are a helpful assistant.',
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

  describe('POST /api/agent/chat/start', () => {
    it('returns 201 with the new agent record', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/agent/chat/start')
        .set('Authorization', `Bearer ${jwt}`)
        .send({ companyId, roleId })
        .expect(201);
      expect((res.body as LcpAgent).id).toBeDefined();
      expect((res.body as LcpAgent).status).toBe('idle');
    });

    it('returns 401 without a token', () =>
      request(app.getHttpServer())
        .post('/api/agent/chat/start')
        .send({ companyId, roleId })
        .expect(401));
  });

  describe('GET /api/agent/:id', () => {
    it('returns 200 with the agent', async () => {
      const created = (
        await request(app.getHttpServer())
          .post('/api/agent/chat/start')
          .set('Authorization', `Bearer ${jwt}`)
          .send({ companyId, roleId })
          .expect(201)
      ).body as LcpAgent;

      const res = await request(app.getHttpServer())
        .get(`/api/agent/${created.id}`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      expect((res.body as LcpAgent).id).toBe(created.id);
    });

    it('returns 404 for an unknown agent id', () =>
      request(app.getHttpServer())
        .get('/api/agent/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${jwt}`)
        .expect(404));
  });

  describe('DELETE /api/agent/:id', () => {
    it('returns 200 and removes the agent', async () => {
      const created = (
        await request(app.getHttpServer())
          .post('/api/agent/chat/start')
          .set('Authorization', `Bearer ${jwt}`)
          .send({ companyId, roleId })
          .expect(201)
      ).body as LcpAgent;

      await request(app.getHttpServer())
        .delete(`/api/agent/${created.id}`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(204);

      await request(app.getHttpServer())
        .get(`/api/agent/${created.id}`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(404);
    });
  });
});
