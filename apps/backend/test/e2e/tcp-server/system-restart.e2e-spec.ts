import {
  AgentStatus,
  AuditEvent,
  TcpAgent,
  TcpAssignment,
  TcpCompany,
  TcpRole,
  TcpTask,
} from '@tcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import type { UUID } from 'crypto';
import { Repository } from 'typeorm';
import { AppModule } from '../../../apps/tcp-server/src/app.module';
import type { ShutdownStatus } from '../../../apps/tcp-server/src/api/system-drain.service';
import { makeTestJwt } from '../helpers/test-jwt';

/** Everything the restarted instance needs to read back. */
interface Repositories {
  company: Repository<TcpCompany>;
  role: Repository<TcpRole>;
  task: Repository<TcpTask>;
  assignment: Repository<TcpAssignment>;
  agent: Repository<TcpAgent>;
  audit: Repository<AuditEvent>;
}

/**
 * Boots a fresh tcp-server instance — the same thing a restart does, including
 * running `TaskRecoveryService`'s startup reconciliation.
 */
async function boot(): Promise<{
  app: INestApplication<App>;
  repos: Repositories;
}> {
  const module: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = module.createNestApplication<INestApplication<App>>();
  // Listening, not just init() — see agent.e2e-spec.ts for why.
  await app.listen(0);
  return {
    app,
    repos: {
      company: module.get(getRepositoryToken(TcpCompany)),
      role: module.get(getRepositoryToken(TcpRole)),
      task: module.get(getRepositoryToken(TcpTask)),
      assignment: module.get(getRepositoryToken(TcpAssignment)),
      agent: module.get(getRepositoryToken(TcpAgent)),
      audit: module.get(getRepositoryToken(AuditEvent)),
    },
  };
}

describe('Restart after a shutdown (e2e)', () => {
  let app: INestApplication<App>;
  let repos: Repositories;
  let jwt: string;
  let taskId: UUID;
  let assignmentId: UUID;
  let agentId: UUID;
  let restartAgentId: UUID;
  let strandedAgentId: UUID;
  let companyId: UUID;

  beforeAll(async () => {
    // `GET /api/system/shutdown` is administrator-only; TCP_ADMIN_IDENTIFIERS
    // in .env.testing names this `sub`.
    jwt = makeTestJwt({ sub: 'e2e-admin' });

    // Phase 1: the state a graceful shutdown leaves behind — a task still
    // in-progress, its implement assignment still claimed, and the agent
    // working it paused with the shutdown reason.
    const before = await boot();
    const company = await before.repos.company.save(
      before.repos.company.create({
        slug: 'restartco',
        name: 'Restart Co',
        description: 'Restart test company',
      }),
    );
    companyId = company.id;
    const role = await before.repos.role.save(
      before.repos.role.create({
        slug: 'restarter',
        name: 'Restarter',
        description: 'Restart test role',
        systemPromptTemplate: 'You are a helpful assistant.',
        knowledgeDomains: [],
        mcpServerList: [],
        company,
        companyId: company.id,
      }),
    );
    const task = await before.repos.task.save(
      before.repos.task.create({
        companyId: company.id,
        request: 'Finish the report',
        shortcode: '900',
        status: 'in-progress',
        plannerRoleId: role.id,
      }),
    );
    taskId = task.id;
    const assignment = await before.repos.assignment.save(
      before.repos.assignment.create({
        taskId: task.id,
        companyId: company.id,
        roleId: role.id,
        mode: 'implement',
        orderIndex: 0,
        prompt: 'Write the report',
        status: 'in-progress',
      }),
    );
    assignmentId = assignment.id;
    const agent = await before.repos.agent.save(
      before.repos.agent.create({
        companyId: company.id,
        roleId: role.id,
        assignmentId: assignment.id,
        initialPrompt: 'Write the report',
        status: AgentStatus.Paused,
        pausedAt: new Date(),
        pauseReason: 'shutdown',
      }),
    );
    agentId = agent.id;
    await before.repos.assignment.update(assignment.id, { agentId: agent.id });

    // Beside it: an agent a restart drain paused, and one a crash left
    // `running` with no job behind it. Both should carry on after the boot.
    const sideAgent = async (
      orderIndex: number,
      fields: Partial<TcpAgent>,
    ): Promise<UUID> => {
      const side = await before.repos.assignment.save(
        before.repos.assignment.create({
          taskId: task.id,
          companyId: company.id,
          roleId: role.id,
          mode: 'implement',
          orderIndex,
          prompt: 'Check the figures',
          status: 'in-progress',
        }),
      );
      const saved = await before.repos.agent.save(
        before.repos.agent.create({
          companyId: company.id,
          roleId: role.id,
          assignmentId: side.id,
          initialPrompt: 'Check the figures',
          ...fields,
        }),
      );
      await before.repos.assignment.update(side.id, { agentId: saved.id });
      return saved.id;
    };
    restartAgentId = await sideAgent(1, {
      status: AgentStatus.Paused,
      pausedAt: new Date(),
      pauseReason: 'restart',
    });
    strandedAgentId = await sideAgent(2, { status: AgentStatus.Running });
    await before.app.close();

    // Phase 2: the stack comes back up.
    const after = await boot();
    app = after.app;
    repos = after.repos;
  });

  afterAll(async () => {
    await repos.audit.createQueryBuilder().delete().execute();
    await repos.agent.createQueryBuilder().delete().execute();
    await repos.assignment.createQueryBuilder().delete().execute();
    await repos.task.createQueryBuilder().delete().execute();
    await repos.role.createQueryBuilder().delete().execute();
    await repos.company.createQueryBuilder().delete().execute();
    await app.close();
  });

  it('comes back up accepting work, not still refusing it', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/system/shutdown')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);
    expect((res.body as ShutdownStatus).state).toBe('idle');

    await request(app.getHttpServer())
      .post('/api/agent/chat/start')
      .set('Authorization', `Bearer ${jwt}`)
      .send({
        companyId,
        roleId: (await repos.agent.findOneByOrFail({ id: agentId })).roleId,
      })
      .expect(201);
  });

  it('leaves the shutdown-paused agent paused rather than mistaking it for dead', async () => {
    const agent = await repos.agent.findOneByOrFail({ id: agentId });
    expect(agent.status).toBe(AgentStatus.Paused);
    expect(agent.pauseReason).toBe('shutdown');
  });

  it('resumes an agent a restart paused, by itself', async () => {
    const agent = await repos.agent.findOneByOrFail({ id: restartAgentId });
    expect(agent.status).toBe(AgentStatus.Queued);
    expect(agent.pauseReason).toBeNull();
  });

  it('carries on an agent a crash stranded running, marking it recovered', async () => {
    const agent = await repos.agent.findOneByOrFail({ id: strandedAgentId });
    expect(agent.status).toBe(AgentStatus.Queued);
    const changes = await repos.audit.findBy({ agentId: strandedAgentId });
    expect(changes.some((event) => event.payload['recovered'] === true)).toBe(
      true,
    );
  });

  it('does not fail the task its paused agent was working', async () => {
    // Startup reconciliation only repairs work no live agent will finish; a
    // shutdown-paused agent is waiting to be resumed, not dead.
    const task = await repos.task.findOneByOrFail({ id: taskId });
    expect(task.status).toBe('in-progress');
    expect(task.failureReason).toBeNull();

    const assignment = await repos.assignment.findOneByOrFail({
      id: assignmentId,
    });
    expect(assignment.status).toBe('in-progress');
  });

  it('resumes the agent explicitly, clearing the shutdown pause', async () => {
    await request(app.getHttpServer())
      .post(`/api/agent/resume/${agentId}`)
      .set('Authorization', `Bearer ${jwt}`)
      .expect(201);

    const resumed = await repos.agent.findOneByOrFail({ id: agentId });
    expect(resumed.pausedAt).toBeNull();
    expect(resumed.pauseReason).toBeNull();
  });
});
