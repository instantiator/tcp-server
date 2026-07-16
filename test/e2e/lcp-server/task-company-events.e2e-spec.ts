import {
  LcpCompany,
  LcpTask,
  type CompanyEvent,
  type TaskEvent,
} from '@lcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../../apps/lcp-server/src/app.module';
import { consumeSse } from '../helpers/consume-sse';
import { makeTestJwt } from '../helpers/test-jwt';

/**
 * Exercises `GET /api/company/:id/events` and `GET /api/task/:id/events`
 * end-to-end over real HTTP (`docs/prompts/010.3.2` §2) — priming with the
 * current state, then observing a live `task_changed` transition driven
 * through the real `TaskService`/`TaskOrchestrationService` stack. Runs
 * against the real Redis started by this suite's global setup, so this also
 * covers the cross-process publish+relay path (see `keyed-event-bus.spec.ts`
 * for the in-memory/no-Redis path and the retain/release ref-counting
 * assertions, which are impractical to observe against a real Redis
 * instance).
 */
describe('Company/Task SSE events (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<LcpCompany>;
  let taskRepo: Repository<LcpTask>;
  let jwt: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    // Real streaming needs a listening socket — supertest's buffered
    // `request(app.getHttpServer())` can't observe a long-lived SSE response.
    await app.listen(0);

    companyRepo = moduleFixture.get(getRepositoryToken(LcpCompany));
    taskRepo = moduleFixture.get(getRepositoryToken(LcpTask));
    jwt = makeTestJwt();
  });

  async function createCompany(): Promise<LcpCompany> {
    const res = await request(app.getHttpServer())
      .post('/api/company')
      .set('Authorization', `Bearer ${jwt}`)
      .send({
        slug: `sse-co-${Date.now()}`,
        name: 'SSE Co',
        description: 'test',
      });
    return res.body as LcpCompany;
  }

  async function createTask(companyId: string): Promise<LcpTask> {
    const res = await request(app.getHttpServer())
      .post('/api/task')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ companyId, request: 'Write a report' });
    return res.body as LcpTask;
  }

  afterEach(async () => {
    await taskRepo.createQueryBuilder().delete().execute();
  });

  afterAll(async () => {
    // Must run before app.close() — a closed app drops its DB connection.
    await companyRepo.createQueryBuilder().delete().execute();
    await app.close();
  });

  it('primes both streams with current state, then both observe a cancel transition', async () => {
    const company = await createCompany();
    const task = await createTask(company.id);
    const authHeaders = { Authorization: `Bearer ${jwt}` };

    const taskEvents$ = consumeSse<TaskEvent>(
      app,
      `/api/task/${task.id}/events`,
      authHeaders,
      2,
    );
    const companyEvents$ = consumeSse<CompanyEvent>(
      app,
      `/api/company/${company.id}/events`,
      authHeaders,
      3,
    );

    // Give both connections time to establish and receive their priming
    // events before driving the transition, so the live event isn't raced.
    await new Promise((resolve) => setTimeout(resolve, 300));

    await request(app.getHttpServer())
      .post(`/api/task/${task.id}/cancel`)
      .set('Authorization', `Bearer ${jwt}`)
      .expect(202);

    const [taskEvents, companyEvents] = await Promise.all([
      taskEvents$,
      companyEvents$,
    ]);

    // Task stream: primed with the task's current ('ready') state, then the
    // live 'cancelled' transition.
    expect(taskEvents).toHaveLength(2);
    expect(taskEvents[0]).toMatchObject({
      kind: 'task_changed',
      data: { id: task.id, status: 'ready' },
    });
    expect(taskEvents[1]).toMatchObject({
      kind: 'task_changed',
      data: { id: task.id, status: 'cancelled' },
    });

    // Company stream: primed with a company_changed signal + the task's
    // current state, then the live transition.
    expect(companyEvents).toHaveLength(3);
    expect(companyEvents[0]).toMatchObject({
      kind: 'company_changed',
      data: { companyId: company.id },
    });
    expect(companyEvents[1]).toMatchObject({
      kind: 'task_changed',
      data: { id: task.id, status: 'ready' },
    });
    expect(companyEvents[2]).toMatchObject({
      kind: 'task_changed',
      data: { id: task.id, status: 'cancelled' },
    });
  }, 15000);

  // NestJS's @Sse() writes the 200 + text/event-stream response headers as
  // soon as the handler returns an Observable — before this priming logic's
  // async NotFoundException can surface — so an unknown id can't 404 like a
  // normal REST route; the connection instead opens with no priming events
  // and then closes. (Direct-Observable callers, e.g. the unit tests for
  // these controllers, still see the real NotFoundException.)
  it('opens but emits no events for an unknown task id', async () => {
    const events = await consumeSse(
      app,
      '/api/task/00000000-0000-0000-0000-000000000000/events',
      { Authorization: `Bearer ${jwt}` },
      1,
      1000,
    );
    expect(events).toEqual([]);
  });

  it('opens but emits no events for an unknown company id', async () => {
    const events = await consumeSse(
      app,
      '/api/company/00000000-0000-0000-0000-000000000000/events',
      { Authorization: `Bearer ${jwt}` },
      1,
      1000,
    );
    expect(events).toEqual([]);
  });

  it('returns 401 without a bearer token on either stream', async () => {
    const company = await createCompany();
    const task = await createTask(company.id);

    const taskRes = await request(app.getHttpServer()).get(
      `/api/task/${task.id}/events`,
    );
    expect(taskRes.status).toBe(401);

    const companyRes = await request(app.getHttpServer()).get(
      `/api/company/${company.id}/events`,
    );
    expect(companyRes.status).toBe(401);
  });
});
