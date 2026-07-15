import {
  AuditEvent,
  LcpAgent,
  LcpAssignment,
  LcpCompany,
  LcpRole,
} from '@lcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import type { UUID } from 'crypto';
import { Repository } from 'typeorm';
import { AppModule } from '../../../apps/lcp-server/src/app.module';
import { makeTestJwt } from '../helpers/test-jwt';

describe('AgentController (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<LcpCompany>;
  let roleRepo: Repository<LcpRole>;
  let agentRepo: Repository<LcpAgent>;
  let assignmentRepo: Repository<LcpAssignment>;
  let auditRepo: Repository<AuditEvent>;
  let jwt: string;
  let companyId: UUID;
  let roleId: UUID;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    companyRepo = module.get(getRepositoryToken(LcpCompany));
    roleRepo = module.get(getRepositoryToken(LcpRole));
    agentRepo = module.get(getRepositoryToken(LcpAgent));
    assignmentRepo = module.get(getRepositoryToken(LcpAssignment));
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
        slug: 'engineer',
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
    await assignmentRepo.createQueryBuilder().delete().execute();
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
      // Every agent is created with an assignment — an orphan chat-mode one
      // here (empty prompt for chat-start).
      const assignmentId = (res.body as LcpAgent).assignmentId;
      expect(assignmentId).toBeDefined();
      const assignment = await assignmentRepo.findOneByOrFail({
        id: assignmentId,
      });
      expect(assignment.taskId).toBeNull();
      expect(assignment.mode).toBe('chat');
      expect(assignment.agentId).toBe((res.body as LcpAgent).id);
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

  describe('GET /api/agent', () => {
    it('returns 400 without companyId, roleId, or assignmentId', () =>
      request(app.getHttpServer())
        .get('/api/agent')
        .set('Authorization', `Bearer ${jwt}`)
        .expect(400));

    it('lists agents for a company, defaulting to active statuses', async () => {
      const created = (
        await request(app.getHttpServer())
          .post('/api/agent/chat/start')
          .set('Authorization', `Bearer ${jwt}`)
          .send({ companyId, roleId })
          .expect(201)
      ).body as LcpAgent;

      const res = await request(app.getHttpServer())
        .get(`/api/agent?companyId=${companyId}`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      expect((res.body as LcpAgent[]).map((a) => a.id)).toContain(created.id);
    });

    it('filters by an explicit status', async () => {
      const created = (
        await request(app.getHttpServer())
          .post('/api/agent/chat/start')
          .set('Authorization', `Bearer ${jwt}`)
          .send({ companyId, roleId })
          .expect(201)
      ).body as LcpAgent;

      const res = await request(app.getHttpServer())
        .get(`/api/agent?companyId=${companyId}&status=completed`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      expect((res.body as LcpAgent[]).map((a) => a.id)).not.toContain(
        created.id,
      );
    });
  });

  describe('GET /api/agent/:id/history', () => {
    it('returns the audit rows recorded for the agent, oldest first', async () => {
      const created = (
        await request(app.getHttpServer())
          .post('/api/agent/chat/start')
          .set('Authorization', `Bearer ${jwt}`)
          .send({ companyId, roleId })
          .expect(201)
      ).body as LcpAgent;

      await auditRepo.save(
        auditRepo.create({
          companyId,
          role: 'engineer',
          agentId: created.id,
          eventType: 'state_change',
          payload: { newStatus: 'running', reason: 'test' },
        }),
      );
      await auditRepo.save(
        auditRepo.create({
          companyId,
          role: 'engineer',
          agentId: created.id,
          eventType: 'agent_loop_completion',
          payload: { summary: 'done' },
        }),
      );

      const res = await request(app.getHttpServer())
        .get(`/api/agent/${created.id}/history`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      const rows = res.body as AuditEvent[];
      // /chat/start itself records a 'chat session created' state_change
      // first, so the two rows added above land after it, oldest first.
      expect(rows).toHaveLength(3);
      expect(rows[1].eventType).toBe('state_change');
      expect(rows[1].payload).toMatchObject({ reason: 'test' });
      expect(rows[2].eventType).toBe('agent_loop_completion');
    });

    it('returns 404 for an unknown agent id', () =>
      request(app.getHttpServer())
        .get('/api/agent/00000000-0000-0000-0000-000000000000/history')
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
