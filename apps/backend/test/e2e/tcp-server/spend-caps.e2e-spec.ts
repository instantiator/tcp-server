import {
  AgentStatus,
  Conversation,
  TcpAgent,
  TcpAssignment,
  TcpCompany,
  TcpRole,
  TcpTask,
  type PauseReason,
} from '@tcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../../apps/tcp-server/src/app.module';
import { makeTestJwt } from '../helpers/test-jwt';

/**
 * Exercises the spend-cap and task-control routes over real HTTP and
 * Postgres: who may lift or restore a cap; how a user pauses a task; and
 * which agents an explicit task or company resume lifts.
 *
 * `.env.testing` sets no `SPEND_CAPS`, so no cap is ever reached here and no
 * resume exempts a task. Cap evaluation and exemption are covered by unit
 * specs and the stub-LLM integration scenario.
 */
describe('Spend caps and task controls (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<TcpCompany>;
  let roleRepo: Repository<TcpRole>;
  let taskRepo: Repository<TcpTask>;
  let assignmentRepo: Repository<TcpAssignment>;
  let agentRepo: Repository<TcpAgent>;
  let convRepo: Repository<Conversation>;
  let member: { Authorization: string };
  let admin: { Authorization: string };
  let stranger: { Authorization: string };
  let company: TcpCompany;
  let role: TcpRole;

  /** A task created through the API, as the company's member. */
  async function createTask(): Promise<TcpTask> {
    const res = await request(app.getHttpServer())
      .post('/api/task')
      .set(member)
      .send({
        companyId: company.id,
        request: 'Write a report',
        plannerRoleId: role.id,
      })
      .expect(201);
    return res.body as TcpTask;
  }

  /** An agent on `task`, paused for `reason` (or working, with `null`). */
  async function pausedAgent(
    task: TcpTask,
    reason: PauseReason | null,
  ): Promise<TcpAgent> {
    const assignment = await assignmentRepo.save(
      assignmentRepo.create({
        companyId: company.id,
        roleId: role.id,
        taskId: task.id,
        mode: 'implement',
        status: 'in-progress',
        prompt: 'Spend cap fixture',
      }),
    );
    return agentRepo.save(
      agentRepo.create({
        companyId: company.id,
        roleId: role.id,
        assignmentId: assignment.id,
        initialPrompt: 'Keep working.',
        ...(reason
          ? {
              status: AgentStatus.Paused,
              pausedAt: new Date(),
              pauseReason: reason,
            }
          : { status: AgentStatus.Running }),
      }),
    );
  }

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.listen(0);
    companyRepo = module.get(getRepositoryToken(TcpCompany));
    roleRepo = module.get(getRepositoryToken(TcpRole));
    taskRepo = module.get(getRepositoryToken(TcpTask));
    assignmentRepo = module.get(getRepositoryToken(TcpAssignment));
    agentRepo = module.get(getRepositoryToken(TcpAgent));
    convRepo = module.get(getRepositoryToken(Conversation));

    member = { Authorization: `Bearer ${makeTestJwt()}` };
    // TCP_ADMIN_IDENTIFIERS in .env.testing names this `sub`.
    admin = { Authorization: `Bearer ${makeTestJwt({ sub: 'e2e-admin' })}` };
    stranger = {
      Authorization: `Bearer ${makeTestJwt({ sub: 'spend-stranger' })}`,
    };

    company = (
      await request(app.getHttpServer())
        .post('/api/company')
        .set(member)
        .send({
          slug: `spendco-${Date.now()}`,
          name: 'Spend Co',
          description: 'test',
        })
        .expect(201)
    ).body as TcpCompany;
    role = await roleRepo.save(
      roleRepo.create({
        slug: 'spender',
        name: 'Spender',
        description: 'Spend cap test role',
        systemPromptTemplate: 'You are a helpful assistant.',
        knowledgeDomains: [],
        mcpServerList: [],
        companyId: company.id,
      }),
    );
  });

  afterAll(async () => {
    await convRepo.delete({ companyId: company.id });
    await agentRepo.createQueryBuilder().delete().execute();
    await assignmentRepo.createQueryBuilder().delete().execute();
    await taskRepo.createQueryBuilder().delete().execute();
    await roleRepo.createQueryBuilder().delete().execute();
    await companyRepo.createQueryBuilder().delete().execute();
    await app.close();
  });

  describe('lifting and restoring a cap', () => {
    it.each(['dismiss', 'restore'])(
      'refuses %s to a non-administrator',
      async (action) => {
        await request(app.getHttpServer())
          .post(`/api/spend/caps/anthropic/${action}`)
          .set(member)
          .send({ until: 'reset' })
          .expect(403);
      },
    );

    it('404s for a provider with no configured cap', async () => {
      await request(app.getHttpServer())
        .post('/api/spend/caps/anthropic/dismiss')
        .set(admin)
        .send({ until: 'indefinite' })
        .expect(404);
      await request(app.getHttpServer())
        .post('/api/spend/caps/anthropic/restore')
        .set(admin)
        .expect(404);
    });

    it('rejects an unknown dismissal', async () => {
      await request(app.getHttpServer())
        .post('/api/spend/caps/anthropic/dismiss')
        .set(admin)
        .send({ until: 'forever' })
        .expect(400);
    });
  });

  /** A task moved straight to `in-progress`, as if its plan had been made. */
  async function runningTask(): Promise<TcpTask> {
    const task = await createTask();
    await taskRepo.update(task.id, { status: 'in-progress' });
    return taskRepo.findOneByOrFail({ id: task.id });
  }

  describe('pausing a task', () => {
    it('pauses a running task and its working agents, naming who paused it', async () => {
      const task = await runningTask();
      const working = await pausedAgent(task, null);

      await request(app.getHttpServer())
        .post(`/api/task/${task.id}/pause`)
        .set(member)
        .expect(202);

      const paused = await taskRepo.findOneByOrFail({ id: task.id });
      expect(paused.pausedAt).not.toBeNull();
      expect(paused.pausedBy).toEqual(expect.any(String));
      const agent = await agentRepo.findOneByOrFail({ id: working.id });
      expect(agent.status).toBe(AgentStatus.Paused);
      expect(agent.pauseReason).toBe('manual');
    });

    it('reports a manual pause as `waiting` on the task detail', async () => {
      const task = await runningTask();
      await request(app.getHttpServer())
        .post(`/api/task/${task.id}/pause`)
        .set(member)
        .expect(202);

      const res = await request(app.getHttpServer())
        .get(`/api/task/${task.id}`)
        .set(member)
        .expect(200);
      const { waiting } = res.body as {
        waiting: { kind: string; pausedBy?: string };
      };
      expect(waiting.kind).toBe('manual');
      expect(typeof waiting.pausedBy).toBe('string');
    });

    it("409s a task that hasn't started", async () => {
      const task = await createTask();
      await request(app.getHttpServer())
        .post(`/api/task/${task.id}/pause`)
        .set(member)
        .expect(409);
    });

    it('409s a task that is already paused', async () => {
      const task = await runningTask();
      await request(app.getHttpServer())
        .post(`/api/task/${task.id}/pause`)
        .set(member)
        .expect(202);
      await request(app.getHttpServer())
        .post(`/api/task/${task.id}/pause`)
        .set(member)
        .expect(409);
    });

    it("refuses a pause to someone outside the task's company", async () => {
      const task = await runningTask();
      await request(app.getHttpServer())
        .post(`/api/task/${task.id}/pause`)
        .set(stranger)
        .expect(403);
    });

    it("refuses to resume one agent of a paused task, rather than undoing the user's pause", async () => {
      const task = await runningTask();
      const working = await pausedAgent(task, null);
      await request(app.getHttpServer())
        .post(`/api/task/${task.id}/pause`)
        .set(member)
        .expect(202);

      await request(app.getHttpServer())
        .post(`/api/agent/resume/${working.id}`)
        .set(member)
        .expect(409);
    });

    it("resuming the task lifts the user's pause and resumes its agents", async () => {
      const task = await runningTask();
      const working = await pausedAgent(task, null);
      await request(app.getHttpServer())
        .post(`/api/task/${task.id}/pause`)
        .set(member)
        .expect(202);

      const res = await request(app.getHttpServer())
        .post(`/api/task/${task.id}/resume`)
        .set(member)
        .expect(202);

      expect(res.body).toEqual({ resumed: 1 });
      const resumed = await taskRepo.findOneByOrFail({ id: task.id });
      expect(resumed.pausedAt).toBeNull();
      expect(resumed.pausedBy).toBeNull();
      expect(
        (await agentRepo.findOneByOrFail({ id: working.id })).pausedAt,
      ).toBeNull();
    });
  });

  describe("closing a task's room", () => {
    it('closes the room of a finished task', async () => {
      const task = await createTask();
      await taskRepo.update(task.id, { status: 'succeeded' });

      await request(app.getHttpServer())
        .post(`/api/task/${task.id}/close-visualisation`)
        .set(member)
        .expect(202);

      expect(
        (await taskRepo.findOneByOrFail({ id: task.id })).visualisationClosedAt,
      ).not.toBeNull();
    });

    it('409s a task still going', async () => {
      const task = await runningTask();
      await request(app.getHttpServer())
        .post(`/api/task/${task.id}/close-visualisation`)
        .set(member)
        .expect(409);
    });

    it("refuses someone outside the task's company", async () => {
      const task = await createTask();
      await taskRepo.update(task.id, { status: 'failed' });
      await request(app.getHttpServer())
        .post(`/api/task/${task.id}/close-visualisation`)
        .set(stranger)
        .expect(403);
    });
  });

  describe('resuming a task', () => {
    it('resumes its paused agents, leaving one still waiting on a reply', async () => {
      const task = await createTask();
      const capped = await pausedAgent(task, 'spend_cap');
      const drained = await pausedAgent(task, 'shutdown');
      const asking = await pausedAgent(task, 'user_input');
      await convRepo.save(
        convRepo.create({
          slug: `ask-${asking.id}`,
          companyId: company.id,
          roleName: role.name,
          roleId: role.id,
          agentId: asking.id,
          question: 'Which colour?',
          status: 'awaiting_user',
        }),
      );

      const res = await request(app.getHttpServer())
        .post(`/api/task/${task.id}/resume`)
        .set(member)
        .expect(202);

      // Counts resume requests: the asking agent is asked too, but stays
      // paused because its question is still open.
      expect(res.body).toEqual({ resumed: 3 });
      // No cap is reached, so resuming doesn't switch off spend protection.
      expect(
        (await taskRepo.findOneByOrFail({ id: task.id })).spendCapExempt,
      ).toBe(false);
      // A queued resume claims the pause by clearing pausedAt.
      for (const agent of [capped, drained]) {
        expect(
          (await agentRepo.findOneByOrFail({ id: agent.id })).pausedAt,
        ).toBeNull();
      }
      expect(
        (await agentRepo.findOneByOrFail({ id: asking.id })).pausedAt,
      ).not.toBeNull();
    });

    it("refuses a resume to someone outside the task's company", async () => {
      const task = await createTask();
      await request(app.getHttpServer())
        .post(`/api/task/${task.id}/resume`)
        .set(stranger)
        .expect(403);
    });

    it('does not exempt a task started while no cap is reached', async () => {
      const task = await createTask();
      await request(app.getHttpServer())
        .post(`/api/task/${task.id}/start`)
        .set(member)
        .expect(202);
      expect(
        (await taskRepo.findOneByOrFail({ id: task.id })).spendCapExempt,
      ).toBe(false);
    });
  });

  it('resuming a company resumes each of its paused tasks, exempting none while no cap is reached', async () => {
    const first = await createTask();
    const second = await createTask();
    await pausedAgent(first, 'spend_cap');
    await pausedAgent(second, 'spend_cap');

    const res = await request(app.getHttpServer())
      .post(`/api/company/${company.id}/resume`)
      .set(member)
      .expect(202);

    expect((res.body as { resumed: number }).resumed).toBeGreaterThanOrEqual(2);
    for (const task of [first, second]) {
      expect(
        (await taskRepo.findOneByOrFail({ id: task.id })).spendCapExempt,
      ).toBe(false);
    }
  });
});
