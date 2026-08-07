import {
  AgentStatus,
  AuditEvent,
  SHUTDOWN_STATUS_CHANNEL,
  TcpAgent,
  TcpAssignment,
  TcpCompany,
  TcpRole,
  TcpTask,
} from '@tcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import Redis from 'ioredis';
import request from 'supertest';
import { App } from 'supertest/types';
import type { UUID } from 'crypto';
import { Repository } from 'typeorm';
import { AppModule } from '../../../apps/tcp-server/src/app.module';
import type { ShutdownStatus } from '../../../apps/tcp-server/src/api/system-drain.service';
import { makeTestJwt } from '../helpers/test-jwt';

/**
 * Polls `GET /api/system/shutdown` until it reports the expected state.
 *
 * Worker reports arrive over Redis pub/sub, so the transition to `quiesced`
 * is inherently asynchronous — a single read after publishing would be flaky.
 */
async function waitForState(
  app: INestApplication<App>,
  jwt: string,
  expected: ShutdownStatus['state'],
): Promise<ShutdownStatus> {
  let last: ShutdownStatus | undefined;
  for (let attempt = 0; attempt < 40; attempt++) {
    const res = await request(app.getHttpServer())
      .get('/api/system/shutdown')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);
    last = res.body as ShutdownStatus;
    if (last.state === expected) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for shutdown state '${expected}'; last saw ${JSON.stringify(last)}`,
  );
}

describe('SystemController (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<TcpCompany>;
  let roleRepo: Repository<TcpRole>;
  let agentRepo: Repository<TcpAgent>;
  let assignmentRepo: Repository<TcpAssignment>;
  let taskRepo: Repository<TcpTask>;
  let auditRepo: Repository<AuditEvent>;
  let publisher: Redis;
  let jwt: string;
  let companyId: UUID;
  let roleId: UUID;

  /** Inserts an agent already believed to be running a loop. */
  async function makeRunningAgent(): Promise<TcpAgent> {
    const assignment = await assignmentRepo.save(
      assignmentRepo.create({
        companyId,
        roleId,
        mode: 'chat',
        status: 'in-progress',
        prompt: 'Shutdown drain fixture',
      }),
    );
    return agentRepo.save(
      agentRepo.create({
        companyId,
        roleId,
        assignmentId: assignment.id,
        initialPrompt: 'Keep working.',
        status: AgentStatus.Running,
      }),
    );
  }

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    companyRepo = module.get(getRepositoryToken(TcpCompany));
    roleRepo = module.get(getRepositoryToken(TcpRole));
    agentRepo = module.get(getRepositoryToken(TcpAgent));
    assignmentRepo = module.get(getRepositoryToken(TcpAssignment));
    taskRepo = module.get(getRepositoryToken(TcpTask));
    auditRepo = module.get(getRepositoryToken(AuditEvent));
    // Draining the system is an administrator action: every route this suite
    // drives is `@AdminOnly()`, and TCP_ADMIN_IDENTIFIERS in .env.testing names
    // this `sub`.
    jwt = makeTestJwt({ sub: 'e2e-admin' });

    publisher = new Redis(process.env.REDIS_URL as string);
    // An unhandled 'error' from a shared-process connection can crash an
    // unrelated suite, so swallow it here as the app's own clients do.
    publisher.on('error', () => undefined);

    const company = await companyRepo.save(
      companyRepo.create({
        slug: 'drainco',
        name: 'Drain Co',
        description: 'Shutdown test company',
      }),
    );
    companyId = company.id;
    const role = await roleRepo.save(
      roleRepo.create({
        slug: 'drainer',
        name: 'Drainer',
        description: 'Shutdown test role',
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
    // Every spec must leave the system accepting work, or the next one's
    // intake calls would be refused by a drain it never started.
    await request(app.getHttpServer())
      .delete('/api/system/shutdown')
      .set('Authorization', `Bearer ${jwt}`);
    await auditRepo.createQueryBuilder().delete().execute();
    await agentRepo.createQueryBuilder().delete().execute();
    await taskRepo.createQueryBuilder().delete().execute();
    await assignmentRepo.createQueryBuilder().delete().execute();
  });

  afterAll(async () => {
    await roleRepo.createQueryBuilder().delete().execute();
    await companyRepo.createQueryBuilder().delete().execute();
    await publisher.quit().catch(() => undefined);
    await app.close();
  });

  describe('GET /api/system/shutdown', () => {
    it('reports idle before any drain', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/system/shutdown')
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      expect(res.body as ShutdownStatus).toEqual({
        state: 'idle',
        forced: false,
        agentsRunning: 0,
      });
    });

    it('returns 401 without a token', () =>
      request(app.getHttpServer()).get('/api/system/shutdown').expect(401));
  });

  describe('POST /api/system/shutdown', () => {
    it('returns 401 without a token', () =>
      request(app.getHttpServer()).post('/api/system/shutdown').expect(401));

    it('quiesces immediately when no agent is running', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/system/shutdown')
        .set('Authorization', `Bearer ${jwt}`)
        .expect(202);
      const status = res.body as ShutdownStatus;
      expect(status.state).toBe('quiesced');
      expect(status.agentsRunning).toBe(0);
      expect(status.forced).toBe(false);
    });

    it('pauses running agents with the shutdown reason, and waits rather than claiming success', async () => {
      const agent = await makeRunningAgent();

      const res = await request(app.getHttpServer())
        .post('/api/system/shutdown')
        .set('Authorization', `Bearer ${jwt}`)
        .expect(202);

      const status = res.body as ShutdownStatus;
      // Still draining: the paused row is the server's own write, and no
      // worker has confirmed the loop actually stopped.
      expect(status.state).toBe('draining');
      expect(status.agentsRunning).toBe(1);

      const paused = await agentRepo.findOneByOrFail({ id: agent.id });
      expect(paused.status).toBe(AgentStatus.Paused);
      expect(paused.pauseReason).toBe('shutdown');
      expect(paused.pausedAt).toBeTruthy();
    });

    it('quiesces once the worker reports no loops left in flight', async () => {
      await makeRunningAgent();
      await request(app.getHttpServer())
        .post('/api/system/shutdown')
        .set('Authorization', `Bearer ${jwt}`)
        .expect(202);

      await publisher.publish(
        SHUTDOWN_STATUS_CHANNEL,
        JSON.stringify({ activeAgents: 0 }),
      );

      const status = await waitForState(app, jwt, 'quiesced');
      expect(status.agentsRunning).toBe(0);
    });

    it('keeps waiting while the worker still reports a loop in flight', async () => {
      await makeRunningAgent();
      await request(app.getHttpServer())
        .post('/api/system/shutdown')
        .set('Authorization', `Bearer ${jwt}`)
        .expect(202);

      await publisher.publish(
        SHUTDOWN_STATUS_CHANNEL,
        JSON.stringify({ activeAgents: 1 }),
      );
      // Give the report time to land before asserting it did not quiesce.
      await new Promise((resolve) => setTimeout(resolve, 100));

      const res = await request(app.getHttpServer())
        .get('/api/system/shutdown')
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      expect((res.body as ShutdownStatus).state).toBe('draining');
      expect((res.body as ShutdownStatus).agentsRunning).toBe(1);
    });

    it('is idempotent — a repeated drain does not re-pause or double-count', async () => {
      await makeRunningAgent();
      await request(app.getHttpServer())
        .post('/api/system/shutdown')
        .set('Authorization', `Bearer ${jwt}`)
        .expect(202);

      const second = await request(app.getHttpServer())
        .post('/api/system/shutdown')
        .set('Authorization', `Bearer ${jwt}`)
        .expect(202);

      expect((second.body as ShutdownStatus).agentsRunning).toBe(1);
      expect((second.body as ShutdownStatus).state).toBe('draining');
    });

    it('escalates an in-progress graceful drain when force is requested', async () => {
      await request(app.getHttpServer())
        .post('/api/system/shutdown')
        .set('Authorization', `Bearer ${jwt}`)
        .expect(202);

      const forced = await request(app.getHttpServer())
        .post('/api/system/shutdown?force')
        .set('Authorization', `Bearer ${jwt}`)
        .expect(202);
      expect((forced.body as ShutdownStatus).forced).toBe(true);
    });

    it('lets an agent that completes naturally during the drain still reach completed', async () => {
      const agent = await makeRunningAgent();
      await request(app.getHttpServer())
        .post('/api/system/shutdown')
        .set('Authorization', `Bearer ${jwt}`)
        .expect(202);

      // The loop finished its own work before noticing the pause.
      await agentRepo.update(agent.id, {
        status: AgentStatus.Completed,
        output: 'done',
      });

      await publisher.publish(
        SHUTDOWN_STATUS_CHANNEL,
        JSON.stringify({ activeAgents: 0 }),
      );
      await waitForState(app, jwt, 'quiesced');

      const settled = await agentRepo.findOneByOrFail({ id: agent.id });
      expect(settled.status).toBe(AgentStatus.Completed);
    });
  });

  describe('intake while draining', () => {
    let taskId: UUID;

    beforeEach(async () => {
      // Created before the drain starts — creating a task is itself intake,
      // and would be refused once draining.
      const task = await request(app.getHttpServer())
        .post('/api/task')
        .set('Authorization', `Bearer ${jwt}`)
        .send({
          companyId,
          request: 'Build the thing',
          plannerRoleId: roleId,
        })
        .expect(201);
      taskId = (task.body as TcpTask).id;

      await request(app.getHttpServer())
        .post('/api/system/shutdown')
        .set('Authorization', `Bearer ${jwt}`)
        .expect(202);
    });

    it('refuses POST /api/agent/start with 503', () =>
      request(app.getHttpServer())
        .post('/api/agent/start')
        .set('Authorization', `Bearer ${jwt}`)
        .send({ companyId, roleId, initialPrompt: 'Do something.' })
        .expect(503));

    it('refuses POST /api/agent/chat/start with 503', () =>
      request(app.getHttpServer())
        .post('/api/agent/chat/start')
        .set('Authorization', `Bearer ${jwt}`)
        .send({ companyId, roleId })
        .expect(503));

    it('refuses POST /api/task/:id/start with 503', () =>
      request(app.getHttpServer())
        .post(`/api/task/${taskId}/start`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(503));

    it('still serves reads', () =>
      request(app.getHttpServer())
        .get(`/api/agent?companyId=${companyId}`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200));
  });

  describe('DELETE /api/system/shutdown', () => {
    it('returns to idle and accepts work again', async () => {
      await request(app.getHttpServer())
        .post('/api/system/shutdown')
        .set('Authorization', `Bearer ${jwt}`)
        .expect(202);

      const cancelled = await request(app.getHttpServer())
        .delete('/api/system/shutdown')
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      expect((cancelled.body as ShutdownStatus).state).toBe('idle');
      expect((cancelled.body as ShutdownStatus).forced).toBe(false);

      await request(app.getHttpServer())
        .post('/api/agent/chat/start')
        .set('Authorization', `Bearer ${jwt}`)
        .send({ companyId, roleId })
        .expect(201);
    });

    it('leaves agents the drain paused still paused, for an explicit resume', async () => {
      const agent = await makeRunningAgent();
      await request(app.getHttpServer())
        .post('/api/system/shutdown')
        .set('Authorization', `Bearer ${jwt}`)
        .expect(202);

      await request(app.getHttpServer())
        .delete('/api/system/shutdown')
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);

      const stillPaused = await agentRepo.findOneByOrFail({ id: agent.id });
      expect(stillPaused.status).toBe(AgentStatus.Paused);
      expect(stillPaused.pauseReason).toBe('shutdown');
    });

    it('reports the current state when there was nothing to cancel', async () => {
      const res = await request(app.getHttpServer())
        .delete('/api/system/shutdown')
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      expect((res.body as ShutdownStatus).state).toBe('idle');
    });

    it('returns 401 without a token', () =>
      request(app.getHttpServer()).delete('/api/system/shutdown').expect(401));
  });
});
