import {
  AgentStatus,
  AuditEvent,
  CompanyUser,
  TcpAgent,
  TcpAssignment,
  TcpCompany,
  TcpRole,
} from '@tcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import type { UUID } from 'crypto';
import { Repository } from 'typeorm';
import { AppModule } from '../../../apps/tcp-server/src/app.module';
import { makeTestJwt } from '../helpers/test-jwt';
import { seedMembership } from '../helpers/seed-membership';

/**
 * Every e2e spec that creates a Nest application now calls `app.listen(0)`
 * rather than only `app.init()`. This is deliberate, and the same reasoning
 * applies across the whole e2e tier, so it is documented once here.
 *
 * supertest's `serverAddress()` only reuses an app's own server if one is
 * already listening; an app that has merely had `init()` called is not, so
 * supertest binds a fresh ephemeral port and closes it again for every
 * single request it sends — thousands of bind/close cycles over a run.
 *
 * That churn collides with Docker: testcontainers maps its containers onto
 * dynamic host ports drawn from the same ephemeral range the OS hands out.
 * With enough bind/close cycles, one of them eventually lands on a port a
 * container is using instead of the app, so a test request gets answered by
 * the container rather than tcp-server (observed in practice as
 * testcontainers' Ryuk replying with `400 "WebSockets request was
 * expected"`).
 *
 * Listening once, up front, collapses those thousands of ephemeral binds
 * into a single fixed port and removes the collision window entirely.
 * `INestApplication#listen` calls `init()` internally, so this is a strict
 * superset of the previous behaviour, not a change to it.
 */
describe('AgentController (e2e)', () => {
  let app: INestApplication<App>;
  let companyUserRepo: Repository<CompanyUser>;
  let companyRepo: Repository<TcpCompany>;
  let roleRepo: Repository<TcpRole>;
  let agentRepo: Repository<TcpAgent>;
  let assignmentRepo: Repository<TcpAssignment>;
  let auditRepo: Repository<AuditEvent>;
  let jwt: string;
  let companyId: UUID;
  let roleId: UUID;
  let otherRoleId: UUID;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.listen(0);
    companyUserRepo = module.get(getRepositoryToken(CompanyUser));
    companyRepo = module.get(getRepositoryToken(TcpCompany));
    roleRepo = module.get(getRepositoryToken(TcpRole));
    agentRepo = module.get(getRepositoryToken(TcpAgent));
    assignmentRepo = module.get(getRepositoryToken(TcpAssignment));
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
    await seedMembership(
      module.get(getRepositoryToken(CompanyUser)),
      company.id,
    );
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
    const otherRole = await roleRepo.save(
      roleRepo.create({
        slug: 'reviewer',
        name: 'Reviewer',
        description: 'Second test role for filter isolation',
        systemPromptTemplate: 'You are a helpful assistant.',
        knowledgeDomains: [],
        mcpServerList: [],
        company,
        companyId: company.id,
      }),
    );
    otherRoleId = otherRole.id;
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
      expect((res.body as TcpAgent).id).toBeDefined();
      expect((res.body as TcpAgent).status).toBe('idle');
      // Every agent is created with an assignment — an orphan chat-mode one
      // here (empty prompt for chat-start).
      const assignmentId = (res.body as TcpAgent).assignmentId;
      expect(assignmentId).toBeDefined();
      const assignment = await assignmentRepo.findOneByOrFail({
        id: assignmentId,
      });
      expect(assignment.taskId).toBeNull();
      expect(assignment.mode).toBe('chat');
      expect(assignment.agentId).toBe((res.body as TcpAgent).id);
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
      ).body as TcpAgent;

      const res = await request(app.getHttpServer())
        .get(`/api/agent/${created.id}`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      expect((res.body as TcpAgent).id).toBe(created.id);
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
      ).body as TcpAgent;

      const res = await request(app.getHttpServer())
        .get(`/api/agent?companyId=${companyId}`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      expect((res.body as TcpAgent[]).map((a) => a.id)).toContain(created.id);
    });

    it('filters by an explicit status', async () => {
      const created = (
        await request(app.getHttpServer())
          .post('/api/agent/chat/start')
          .set('Authorization', `Bearer ${jwt}`)
          .send({ companyId, roleId })
          .expect(201)
      ).body as TcpAgent;

      const res = await request(app.getHttpServer())
        .get(`/api/agent?companyId=${companyId}&status=completed`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      expect((res.body as TcpAgent[]).map((a) => a.id)).not.toContain(
        created.id,
      );
    });

    it('filters by roleId, excluding agents of a different role', async () => {
      const created = (
        await request(app.getHttpServer())
          .post('/api/agent/chat/start')
          .set('Authorization', `Bearer ${jwt}`)
          .send({ companyId, roleId })
          .expect(201)
      ).body as TcpAgent;
      const otherRoleAgent = (
        await request(app.getHttpServer())
          .post('/api/agent/chat/start')
          .set('Authorization', `Bearer ${jwt}`)
          .send({ companyId, roleId: otherRoleId })
          .expect(201)
      ).body as TcpAgent;

      const res = await request(app.getHttpServer())
        .get(`/api/agent?roleId=${roleId}`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      const ids = (res.body as TcpAgent[]).map((a) => a.id);
      expect(ids).toContain(created.id);
      expect(ids).not.toContain(otherRoleAgent.id);
    });

    it('filters by assignmentId', async () => {
      const created = (
        await request(app.getHttpServer())
          .post('/api/agent/chat/start')
          .set('Authorization', `Bearer ${jwt}`)
          .send({ companyId, roleId })
          .expect(201)
      ).body as TcpAgent;
      const other = (
        await request(app.getHttpServer())
          .post('/api/agent/chat/start')
          .set('Authorization', `Bearer ${jwt}`)
          .send({ companyId, roleId })
          .expect(201)
      ).body as TcpAgent;

      const res = await request(app.getHttpServer())
        .get(`/api/agent?assignmentId=${created.assignmentId}`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      const ids = (res.body as TcpAgent[]).map((a) => a.id);
      expect(ids).toEqual([created.id]);
      expect(ids).not.toContain(other.id);
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
      ).body as TcpAgent;

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
      ).body as TcpAgent;

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

  describe('with a second company', () => {
    let otherCompanyId: UUID;
    let otherRoleId2: UUID;
    let strangerJwt: string;

    beforeAll(async () => {
      const other = await companyRepo.save(
        companyRepo.create({
          slug: 'globex',
          name: 'Globex',
          description: 'Second company',
        }),
      );
      otherCompanyId = other.id;
      const role = await roleRepo.save(
        roleRepo.create({
          slug: 'engineer',
          name: 'Engineer',
          description: 'Test role',
          systemPromptTemplate: 'You are a helpful assistant.',
          knowledgeDomains: [],
          mcpServerList: [],
          company: other,
          companyId: other.id,
        }),
      );
      otherRoleId2 = role.id;
      // The default test user belongs to Acme only.
      strangerJwt = makeTestJwt({ sub: 'stranger' });
    });

    afterAll(async () => {
      await roleRepo.delete({ id: otherRoleId2 });
      await companyRepo.delete({ id: otherCompanyId });
    });

    const startChat = async (
      forCompany: UUID,
      forRole: UUID,
    ): Promise<TcpAgent> =>
      (
        await request(app.getHttpServer())
          .post('/api/agent/chat/start')
          .set('Authorization', `Bearer ${jwt}`)
          .send({ companyId: forCompany, roleId: forRole })
          .expect(201)
      ).body as TcpAgent;

    describe('DELETE /api/agent/:id/chat', () => {
      let chat: TcpAgent;

      beforeEach(async () => {
        chat = await startChat(companyId, roleId);
        await auditRepo.save(
          auditRepo.create({
            companyId,
            role: 'engineer',
            agentId: chat.id,
            eventType: 'state_change',
            payload: { reason: 'extra' },
          }),
        );
      });

      it('returns 204 and removes the assignment, agent and audit rows', async () => {
        await request(app.getHttpServer())
          .delete(`/api/agent/${chat.id}/chat`)
          .set('Authorization', `Bearer ${jwt}`)
          .expect(204);

        expect(
          await assignmentRepo.findOneBy({ id: chat.assignmentId }),
        ).toBeNull();
        expect(await agentRepo.findOneBy({ id: chat.id })).toBeNull();
        expect(await auditRepo.countBy({ agentId: chat.id })).toBe(0);
        expect(
          await auditRepo.countBy({ assignmentId: chat.assignmentId }),
        ).toBe(0);
      });

      it('returns 404 for an unknown agent id', () =>
        request(app.getHttpServer())
          .delete('/api/agent/00000000-0000-0000-0000-000000000000/chat')
          .set('Authorization', `Bearer ${jwt}`)
          .expect(404));

      it('returns 400 for an agent that is not a chat', async () => {
        await assignmentRepo.update(
          { id: chat.assignmentId },
          { mode: 'implement' },
        );
        await request(app.getHttpServer())
          .delete(`/api/agent/${chat.id}/chat`)
          .set('Authorization', `Bearer ${jwt}`)
          .expect(400);
        expect(await agentRepo.findOneBy({ id: chat.id })).not.toBeNull();
      });

      it('returns 409 while the agent is mid-turn and keeps the chat', async () => {
        await agentRepo.update(
          { id: chat.id },
          { status: AgentStatus.Running },
        );
        await request(app.getHttpServer())
          .delete(`/api/agent/${chat.id}/chat`)
          .set('Authorization', `Bearer ${jwt}`)
          .expect(409);
        expect(await agentRepo.findOneBy({ id: chat.id })).not.toBeNull();
        expect(await auditRepo.countBy({ agentId: chat.id })).toBeGreaterThan(
          0,
        );
      });

      it('returns 403 for a user of another company', () =>
        request(app.getHttpServer())
          .delete(`/api/agent/${chat.id}/chat`)
          .set('Authorization', `Bearer ${strangerJwt}`)
          .expect(403));
    });

    describe('GET /api/agent/search', () => {
      let chat: TcpAgent;
      let otherChat: TcpAgent;

      const search = (q: string, forCompany: string | undefined = companyId) =>
        request(app.getHttpServer())
          .get('/api/agent/search')
          .query({ ...(forCompany ? { companyId: forCompany } : {}), q })
          .set('Authorization', `Bearer ${jwt}`);

      const say = (agent: TcpAgent, forCompany: UUID, text: string) =>
        auditRepo.save(
          auditRepo.create({
            companyId: forCompany,
            role: 'engineer',
            agentId: agent.id,
            eventType: 'state_change',
            payload: { text },
          }),
        );

      beforeAll(async () => {
        await seedMembership(companyUserRepo, otherCompanyId);
      });

      beforeEach(async () => {
        chat = await startChat(companyId, roleId);
        otherChat = await startChat(otherCompanyId, otherRoleId2);
      });

      it('matches case-insensitively', async () => {
        await say(chat, companyId, 'Quarterly Budget review');
        const res = await search('qUARTERLY budget').expect(200);
        expect((res.body as { agentIds: string[] }).agentIds).toEqual([
          chat.id,
        ]);
      });

      it('treats % and _ literally', async () => {
        await say(chat, companyId, 'growth was 50% in total');
        await say(chat, companyId, 'file_name');
        const other = await startChat(companyId, otherRoleId);
        await say(other, companyId, 'revenue 500 units, filexname');

        const pct = await search('50%').expect(200);
        expect((pct.body as { agentIds: string[] }).agentIds).toEqual([
          chat.id,
        ]);
        const spurious = await search('5%0').expect(200);
        expect((spurious.body as { agentIds: string[] }).agentIds).toEqual([]);
        const under = await search('file_name').expect(200);
        expect((under.body as { agentIds: string[] }).agentIds).toEqual([
          chat.id,
        ]);
      });

      it('is scoped to the company', async () => {
        await say(chat, companyId, 'zebra');
        await say(otherChat, otherCompanyId, 'zebra');
        const res = await search('zebra').expect(200);
        expect((res.body as { agentIds: string[] }).agentIds).toEqual([
          chat.id,
        ]);
      });

      it('returns 400 for a query that is too short or too long', async () => {
        await search('a').expect(400);
        await search('a'.repeat(201)).expect(400);
      });

      it('returns 400 without a companyId', () =>
        search('zebra', '').expect(400));
    });
  });
});
