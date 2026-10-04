import {
  AgentStatus,
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
 * Exercises the spend-cap routes over real HTTP and Postgres: who may lift
 * or restore a cap, and how an explicit task or company resume exempts its
 * tasks and resumes only the agents a cap or shutdown paused.
 *
 * `.env.testing` sets no `SPEND_CAPS`, so cap evaluation itself is covered by
 * unit specs and the stub-LLM integration scenario, not here.
 */
describe('Spend caps (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<TcpCompany>;
  let roleRepo: Repository<TcpRole>;
  let taskRepo: Repository<TcpTask>;
  let assignmentRepo: Repository<TcpAssignment>;
  let agentRepo: Repository<TcpAgent>;
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

  /** An agent on `task`, paused for `reason`. */
  async function pausedAgent(
    task: TcpTask,
    reason: PauseReason,
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
        status: AgentStatus.Paused,
        pausedAt: new Date(),
        pauseReason: reason,
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

  describe('resuming a task', () => {
    it('exempts the task and resumes only its cap- and shutdown-paused agents', async () => {
      const task = await createTask();
      const capped = await pausedAgent(task, 'spend_cap');
      const drained = await pausedAgent(task, 'shutdown');
      const asking = await pausedAgent(task, 'user_input');

      const res = await request(app.getHttpServer())
        .post(`/api/task/${task.id}/resume`)
        .set(member)
        .expect(202);

      expect(res.body).toEqual({ resumed: 2 });
      expect(
        (await taskRepo.findOneByOrFail({ id: task.id })).spendCapExempt,
      ).toBe(true);
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

  it('resuming a company exempts and resumes each of its paused tasks', async () => {
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
      ).toBe(true);
    }
  });
});
