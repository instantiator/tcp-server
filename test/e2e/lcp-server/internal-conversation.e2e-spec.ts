import { randomUUID } from 'crypto';
import type { UUID } from 'crypto';
import {
  AgentStatus,
  AuditEvent,
  CompanyUser,
  Conversation,
  ConversationMessage,
  LcpAgent,
  LcpCompany,
  LcpRole,
  PendingConsultation,
} from '@lcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../../apps/lcp-server/src/app.module';
import { makeTestJwt } from '../helpers/test-jwt';

const INTERNAL_KEY = process.env.INTERNAL_API_KEY ?? 'e2e-test-internal-key';

describe('InternalController + ConversationController (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<LcpCompany>;
  let roleRepo: Repository<LcpRole>;
  let agentRepo: Repository<LcpAgent>;
  let convRepo: Repository<Conversation>;
  let msgRepo: Repository<ConversationMessage>;
  let consultRepo: Repository<PendingConsultation>;
  let auditRepo: Repository<AuditEvent>;
  let userRepo: Repository<CompanyUser>;
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
    convRepo = moduleFixture.get(getRepositoryToken(Conversation));
    msgRepo = moduleFixture.get(getRepositoryToken(ConversationMessage));
    consultRepo = moduleFixture.get(getRepositoryToken(PendingConsultation));
    auditRepo = moduleFixture.get(getRepositoryToken(AuditEvent));
    userRepo = moduleFixture.get(getRepositoryToken(CompanyUser));
    jwt = makeTestJwt();
  });

  afterEach(async () => {
    await consultRepo.createQueryBuilder().delete().execute();
    await msgRepo.createQueryBuilder().delete().execute();
    await convRepo.createQueryBuilder().delete().execute();
    await auditRepo.createQueryBuilder().delete().execute();
    await agentRepo.createQueryBuilder().delete().execute();
    await roleRepo.createQueryBuilder().delete().execute();
    await userRepo.createQueryBuilder().delete().execute();
    await companyRepo.createQueryBuilder().delete().execute();
  });

  afterAll(async () => {
    await app.close();
  });

  // ---------------------------------------------------------------------------
  // Shared fixture helpers
  // ---------------------------------------------------------------------------

  async function createCompany(): Promise<LcpCompany> {
    await request(app.getHttpServer())
      .post('/api/company')
      .set('Authorization', `Bearer ${jwt}`)
      .send({
        slug: 'e2e-co',
        name: 'E2E Corp',
        description: 'E2E test company',
      });
    return companyRepo.findOneByOrFail({ slug: 'e2e-co' });
  }

  async function createRole(companyId: UUID): Promise<LcpRole> {
    const res = await request(app.getHttpServer())
      .post('/api/role')
      .set('Authorization', `Bearer ${jwt}`)
      .send({
        companyId,
        name: 'analyst',
        description: 'Analyses things.',
        llmConfig: { provider: 'lm-studio', model: 'qwen3-5b' },
        systemPromptTemplate: 'You are {{name}}.',
        knowledgeDomains: [],
        mcpServerList: [],
      })
      .expect(201);
    return res.body as LcpRole;
  }

  /** Inserts a Running agent directly — bypasses BullMQ so no Redis needed. */
  async function createRunningAgent(
    companyId: UUID,
    roleId: UUID,
  ): Promise<LcpAgent> {
    return agentRepo.save(
      agentRepo.create({
        companyId,
        roleId,
        status: AgentStatus.Running,
        initialPrompt: 'Do some analysis.',
        output: null,
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Auth guard
  // ---------------------------------------------------------------------------

  describe('InternalApiKeyGuard', () => {
    it('returns 401 when X-Internal-Api-Key header is missing', async () => {
      await request(app.getHttpServer())
        .post('/internal/pause')
        .send({
          type: 'user_input',
          agentId: '00000000-0000-0000-0000-000000000001',
          question: 'test',
        })
        .expect(401);
    });

    it('returns 403 when X-Internal-Api-Key is wrong', async () => {
      await request(app.getHttpServer())
        .post('/internal/pause')
        .set('X-Internal-Api-Key', 'wrong-key')
        .send({
          type: 'user_input',
          agentId: '00000000-0000-0000-0000-000000000001',
          question: 'test',
        })
        .expect(403);
    });

    it('returns 401 when key is missing on the complete endpoint', async () => {
      await request(app.getHttpServer())
        .post('/internal/agent/00000000-0000-0000-0000-000000000001/complete')
        .send({ output: 'done' })
        .expect(401);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /internal/pause — user_input
  // ---------------------------------------------------------------------------

  describe('POST /internal/pause (user_input)', () => {
    it('pauses the agent and returns the conversation slug', async () => {
      const company = await createCompany();
      const role = await createRole(company.id);
      const agent = await createRunningAgent(company.id, role.id);

      const res = await request(app.getHttpServer())
        .post('/internal/pause')
        .set('X-Internal-Api-Key', INTERNAL_KEY)
        .send({
          type: 'user_input',
          agentId: agent.id,
          question: 'What should I do next?',
          context: 'Some background.',
        })
        .expect(201);

      const body = res.body as { slug: string };
      expect(body.slug).toMatch(/^analyst-\d+$/);

      const fresh = await agentRepo.findOneByOrFail({ id: agent.id });
      expect(fresh.status).toBe(AgentStatus.Paused);

      const conv = await convRepo.findOneByOrFail({ slug: body.slug });
      expect(conv.agentId).toBe(agent.id);
      expect(conv.companyId).toBe(company.id);
      expect(conv.question).toBe('What should I do next?');
      expect(conv.context).toBe('Some background.');
      expect(conv.status).toBe('awaiting_user');
    });

    it('returns 404 when the agent does not exist', async () => {
      await request(app.getHttpServer())
        .post('/internal/pause')
        .set('X-Internal-Api-Key', INTERNAL_KEY)
        .send({
          type: 'user_input',
          agentId: randomUUID(),
          question: 'Who am I?',
        })
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /internal/pause — agent_consultation
  // ---------------------------------------------------------------------------

  describe('POST /internal/pause (agent_consultation)', () => {
    it('pauses the caller (with pausedAt) and starts a consultation agent for roleId', async () => {
      const company = await createCompany();
      const role = await createRole(company.id);
      const caller = await createRunningAgent(company.id, role.id);

      const res = await request(app.getHttpServer())
        .post('/internal/pause')
        .set('X-Internal-Api-Key', INTERNAL_KEY)
        .send({
          type: 'agent_consultation',
          agentId: caller.id,
          companyId: company.id,
          roleId: role.id,
          question: 'Can you analyse this?',
        })
        .expect(201);

      const body = res.body as { consultationId: string; roleName: string };
      expect(body.roleName).toBe('analyst');

      const fresh = await agentRepo.findOneByOrFail({ id: caller.id });
      expect(fresh.status).toBe(AgentStatus.Paused);
      expect(fresh.pausedAt).toBeTruthy();

      const consult = await consultRepo.findOneByOrFail({
        id: body.consultationId as UUID,
      });
      expect(consult.callingAgentId).toBe(caller.id);
      expect(consult.status).toBe('pending');

      const consultant = await agentRepo.findOneByOrFail({
        id: consult.consultationAgentId,
      });
      expect(consultant.roleId).toBe(role.id);
      // Consultation agents must deliver their answer via complete_task
      expect(consultant.requiredToolCalls).toEqual(['complete_task']);
    });

    it('targets the correct role when two roles in the company share a name (regression)', async () => {
      const company = await createCompany();
      // Two roles named 'analyst' in the same company — the original bug
      // looked these up by name and could resolve to either one.
      const roleA = await createRole(company.id);
      const res = await request(app.getHttpServer())
        .post('/api/role')
        .set('Authorization', `Bearer ${jwt}`)
        .send({
          companyId: company.id,
          name: 'analyst',
          description: 'A second, identically-named role.',
          llmConfig: { provider: 'lm-studio', model: 'qwen3-5b' },
          systemPromptTemplate: 'You are {{name}}.',
          knowledgeDomains: [],
          mcpServerList: [],
        })
        .expect(201);
      const roleB = res.body as LcpRole;
      const caller = await createRunningAgent(company.id, roleA.id);

      const pauseRes = await request(app.getHttpServer())
        .post('/internal/pause')
        .set('X-Internal-Api-Key', INTERNAL_KEY)
        .send({
          type: 'agent_consultation',
          agentId: caller.id,
          companyId: company.id,
          roleId: roleB.id,
          question: 'Can you analyse this?',
        })
        .expect(201);

      const { consultationId } = pauseRes.body as { consultationId: UUID };
      const consult = await consultRepo.findOneByOrFail({
        id: consultationId,
      });
      const consultant = await agentRepo.findOneByOrFail({
        id: consult.consultationAgentId,
      });

      // Targeted role B specifically, not role A — proves the lookup is
      // unambiguous even with a duplicate role name in the company.
      expect(consultant.roleId).toBe(roleB.id);
      expect(consultant.roleId).not.toBe(roleA.id);
    });

    it('returns 404 when roleId does not exist in the company', async () => {
      const company = await createCompany();
      const role = await createRole(company.id);
      const caller = await createRunningAgent(company.id, role.id);

      await request(app.getHttpServer())
        .post('/internal/pause')
        .set('X-Internal-Api-Key', INTERNAL_KEY)
        .send({
          type: 'agent_consultation',
          agentId: caller.id,
          companyId: company.id,
          roleId: randomUUID(),
          question: 'Can you analyse this?',
        })
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /internal/agent/:agentId/complete — no consultation
  // ---------------------------------------------------------------------------

  describe('POST /internal/agent/:agentId/complete (no consultation)', () => {
    it('marks the agent Completed and sets its output', async () => {
      const company = await createCompany();
      const role = await createRole(company.id);
      const agent = await createRunningAgent(company.id, role.id);

      await request(app.getHttpServer())
        .post(`/internal/agent/${agent.id}/complete`)
        .set('X-Internal-Api-Key', INTERNAL_KEY)
        .send({ output: 'Analysis is done. See report.md.' })
        .expect(204);

      const fresh = await agentRepo.findOneByOrFail({ id: agent.id });
      expect(fresh.status).toBe(AgentStatus.Completed);
      expect(fresh.output).toBe('Analysis is done. See report.md.');
    });

    it('is idempotent — a second call on an already-Completed agent is a no-op', async () => {
      const company = await createCompany();
      const role = await createRole(company.id);
      const agent = await createRunningAgent(company.id, role.id);

      await request(app.getHttpServer())
        .post(`/internal/agent/${agent.id}/complete`)
        .set('X-Internal-Api-Key', INTERNAL_KEY)
        .send({ output: 'First output.' })
        .expect(204);

      await request(app.getHttpServer())
        .post(`/internal/agent/${agent.id}/complete`)
        .set('X-Internal-Api-Key', INTERNAL_KEY)
        .send({ output: 'Second output (should be ignored).' })
        .expect(204);

      const fresh = await agentRepo.findOneByOrFail({ id: agent.id });
      expect(fresh.output).toBe('First output.');
    });

    it('returns 204 without error when the agent does not exist (idempotent missing)', async () => {
      await request(app.getHttpServer())
        .post('/internal/agent/00000000-0000-0000-0000-000000000099/complete')
        .set('X-Internal-Api-Key', INTERNAL_KEY)
        .send({ output: 'ghost output' })
        .expect(204);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /internal/agent/:agentId/complete — with consultation record
  // ---------------------------------------------------------------------------

  describe('POST /internal/agent/:agentId/complete (consultation resolution)', () => {
    it('marks consultation complete and sets result', async () => {
      const company = await createCompany();
      const role = await createRole(company.id);

      // Caller is Paused; consultant is Running — created directly to avoid BullMQ
      const caller = await agentRepo.save(
        agentRepo.create({
          companyId: company.id,
          roleId: role.id,
          status: AgentStatus.Paused,
          initialPrompt: 'Wait for analyst.',
          output: null,
        }),
      );
      const consultant = await agentRepo.save(
        agentRepo.create({
          companyId: company.id,
          roleId: role.id,
          status: AgentStatus.Running,
          initialPrompt: 'Analyse this.',
          output: null,
        }),
      );
      await consultRepo.save(
        consultRepo.create({
          callingAgentId: caller.id,
          consultationAgentId: consultant.id,
          companyId: company.id,
          status: 'pending',
          result: null,
        }),
      );

      await request(app.getHttpServer())
        .post(`/internal/agent/${consultant.id}/complete`)
        .set('X-Internal-Api-Key', INTERNAL_KEY)
        .send({ output: 'Consultation answer.' })
        .expect(204);

      const freshConsultant = await agentRepo.findOneByOrFail({
        id: consultant.id,
      });
      expect(freshConsultant.status).toBe(AgentStatus.Completed);
      expect(freshConsultant.output).toBe('Consultation answer.');

      const consult = await consultRepo.findOneBy({
        consultationAgentId: consultant.id,
      });
      expect(consult?.status).toBe('complete');
      expect(consult?.result).toBe('Consultation answer.');
    });
  });

  // ---------------------------------------------------------------------------
  // POST /internal/agent/:agentId/fail
  // ---------------------------------------------------------------------------

  describe('POST /internal/agent/:agentId/fail', () => {
    it('marks the agent Failed when no consultation is pending', async () => {
      const company = await createCompany();
      const role = await createRole(company.id);
      const agent = await createRunningAgent(company.id, role.id);

      await request(app.getHttpServer())
        .post(`/internal/agent/${agent.id}/fail`)
        .set('X-Internal-Api-Key', INTERNAL_KEY)
        .send({ reason: 'LLM produced no output after retry' })
        .expect(204);

      const fresh = await agentRepo.findOneByOrFail({ id: agent.id });
      expect(fresh.status).toBe(AgentStatus.Failed);
    });

    it('resolves the pending consultation as failed with the reason as its result', async () => {
      const company = await createCompany();
      const role = await createRole(company.id);

      const caller = await agentRepo.save(
        agentRepo.create({
          companyId: company.id,
          roleId: role.id,
          status: AgentStatus.Paused,
          initialPrompt: 'Wait for analyst.',
          output: null,
        }),
      );
      const consultant = await agentRepo.save(
        agentRepo.create({
          companyId: company.id,
          roleId: role.id,
          status: AgentStatus.Running,
          initialPrompt: 'Analyse this.',
          output: null,
          requiredToolCalls: ['complete_task'],
        }),
      );
      await consultRepo.save(
        consultRepo.create({
          callingAgentId: caller.id,
          consultationAgentId: consultant.id,
          companyId: company.id,
          status: 'pending',
          result: null,
        }),
      );

      await request(app.getHttpServer())
        .post(`/internal/agent/${consultant.id}/fail`)
        .set('X-Internal-Api-Key', INTERNAL_KEY)
        .send({
          reason:
            'Agent ended without successfully calling required tool(s): complete_task after 2 reminder(s)',
        })
        .expect(204);

      const freshConsultant = await agentRepo.findOneByOrFail({
        id: consultant.id,
      });
      expect(freshConsultant.status).toBe(AgentStatus.Failed);

      const consult = await consultRepo.findOneByOrFail({
        consultationAgentId: consultant.id,
      });
      expect(consult.status).toBe('failed');
      expect(consult.result).toContain('complete_task');
    });

    it('does not clobber an already-Completed agent (complete_task won the race)', async () => {
      const company = await createCompany();
      const role = await createRole(company.id);
      const agent = await createRunningAgent(company.id, role.id);

      await request(app.getHttpServer())
        .post(`/internal/agent/${agent.id}/complete`)
        .set('X-Internal-Api-Key', INTERNAL_KEY)
        .send({ output: 'Real answer.' })
        .expect(204);

      await request(app.getHttpServer())
        .post(`/internal/agent/${agent.id}/fail`)
        .set('X-Internal-Api-Key', INTERNAL_KEY)
        .send({ reason: 'late failure' })
        .expect(204);

      const fresh = await agentRepo.findOneByOrFail({ id: agent.id });
      expect(fresh.status).toBe(AgentStatus.Completed);
      expect(fresh.output).toBe('Real answer.');
    });

    it('returns 204 without error when the agent does not exist', async () => {
      await request(app.getHttpServer())
        .post('/internal/agent/00000000-0000-0000-0000-000000000098/fail')
        .set('X-Internal-Api-Key', INTERNAL_KEY)
        .send({ reason: 'ghost failure' })
        .expect(204);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/conversation/:slug/reply
  // ---------------------------------------------------------------------------

  describe('POST /api/conversation/:slug/reply', () => {
    it('closes the conversation and adds a message', async () => {
      const company = await createCompany();
      const role = await createRole(company.id);
      const agent = await createRunningAgent(company.id, role.id);

      // Pause to create the conversation
      const pauseRes = await request(app.getHttpServer())
        .post('/internal/pause')
        .set('X-Internal-Api-Key', INTERNAL_KEY)
        .send({
          type: 'user_input',
          agentId: agent.id,
          question: 'Please confirm the budget.',
        })
        .expect(201);

      const slug = (pauseRes.body as { slug: string }).slug;

      await request(app.getHttpServer())
        .post(`/api/conversation/${slug}/reply`)
        .set('Authorization', `Bearer ${jwt}`)
        .send({
          content: 'Budget confirmed — £50k.',
          authorIdentifier: 'alice@example.com',
        })
        .expect(201);

      const conv = await convRepo.findOneByOrFail({ slug });
      expect(conv.status).toBe('closed');
      expect(conv.closedAt).not.toBeNull();

      const messages = await msgRepo.find({
        where: { conversationId: conv.id },
      });
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Budget confirmed — £50k.');
      expect(messages[0].authorIdentifier).toBe('alice@example.com');
    });

    it('returns 404 when the conversation does not exist', async () => {
      await request(app.getHttpServer())
        .post('/api/conversation/no-such-slug/reply')
        .set('Authorization', `Bearer ${jwt}`)
        .send({ content: 'Hello?' })
        .expect(404);
    });

    it('returns 409 when the conversation is already closed', async () => {
      const company = await createCompany();
      const role = await createRole(company.id);
      const agent = await createRunningAgent(company.id, role.id);

      const pauseRes = await request(app.getHttpServer())
        .post('/internal/pause')
        .set('X-Internal-Api-Key', INTERNAL_KEY)
        .send({
          type: 'user_input',
          agentId: agent.id,
          question: 'First question.',
        })
        .expect(201);
      const slug = (pauseRes.body as { slug: string }).slug;

      await request(app.getHttpServer())
        .post(`/api/conversation/${slug}/reply`)
        .set('Authorization', `Bearer ${jwt}`)
        .send({ content: 'First reply.' })
        .expect(201);

      // Second reply to an already-closed conversation
      await request(app.getHttpServer())
        .post(`/api/conversation/${slug}/reply`)
        .set('Authorization', `Bearer ${jwt}`)
        .send({ content: 'Duplicate reply.' })
        .expect(409);
    });

    it('returns 401 when no JWT is provided', async () => {
      await request(app.getHttpServer())
        .post('/api/conversation/analyst-1/reply')
        .send({ content: 'Sneaky reply.' })
        .expect(401);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/conversation
  // ---------------------------------------------------------------------------

  describe('GET /api/conversation', () => {
    it('returns open conversations for the company', async () => {
      const company = await createCompany();
      const role = await createRole(company.id);
      const agent = await createRunningAgent(company.id, role.id);

      await request(app.getHttpServer())
        .post('/internal/pause')
        .set('X-Internal-Api-Key', INTERNAL_KEY)
        .send({
          type: 'user_input',
          agentId: agent.id,
          question: 'List test?',
        });

      const res = await request(app.getHttpServer())
        .get(`/api/conversation?companyId=${company.id}&status=awaiting_user`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);

      const list = res.body as { slug: string; status: string }[];
      expect(list).toHaveLength(1);
      expect(list[0].status).toBe('awaiting_user');
    });
  });
});
