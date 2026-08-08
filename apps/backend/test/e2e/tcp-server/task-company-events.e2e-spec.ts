import {
  AgentStatus,
  AuditEvent,
  Conversation,
  TcpAgent,
  TcpAssignment,
  TcpCompany,
  TcpRole,
  TcpTask,
  type WireEvent,
} from '@tcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../../apps/tcp-server/src/app.module';
import { consumeSse } from '../helpers/consume-sse';
import { makeTestJwt } from '../helpers/test-jwt';

const INTERNAL_KEY = process.env.INTERNAL_API_KEY ?? 'e2e-test-internal-key';

/** The `payload.entity` of each event, in arrival order. */
const entitiesOf = (events: WireEvent[]): unknown[] =>
  events.map((e) => (e.type === 'audit' ? e.event.payload.entity : e.type));

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
  let companyRepo: Repository<TcpCompany>;
  let taskRepo: Repository<TcpTask>;
  let roleRepo: Repository<TcpRole>;
  let agentRepo: Repository<TcpAgent>;
  let assignmentRepo: Repository<TcpAssignment>;
  let convRepo: Repository<Conversation>;
  let auditRepo: Repository<AuditEvent>;
  let jwt: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // Real streaming needs a listening socket — supertest's buffered
    // `request(app.getHttpServer())` can't observe a long-lived SSE response.
    // It is also what every other spec now does, for a second reason:
    // see agent.e2e-spec.ts.
    await app.listen(0);

    companyRepo = moduleFixture.get(getRepositoryToken(TcpCompany));
    taskRepo = moduleFixture.get(getRepositoryToken(TcpTask));
    roleRepo = moduleFixture.get(getRepositoryToken(TcpRole));
    agentRepo = moduleFixture.get(getRepositoryToken(TcpAgent));
    assignmentRepo = moduleFixture.get(getRepositoryToken(TcpAssignment));
    convRepo = moduleFixture.get(getRepositoryToken(Conversation));
    auditRepo = moduleFixture.get(getRepositoryToken(AuditEvent));
    jwt = makeTestJwt();
  });

  async function createCompany(): Promise<TcpCompany> {
    const res = await request(app.getHttpServer())
      .post('/api/company')
      .set('Authorization', `Bearer ${jwt}`)
      .send({
        slug: `sse-co-${Date.now()}`,
        name: 'SSE Co',
        description: 'test',
      });
    return res.body as TcpCompany;
  }

  async function createTask(companyId: string): Promise<TcpTask> {
    const res = await request(app.getHttpServer())
      .post('/api/task')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ companyId, request: 'Write a report' });
    return res.body as TcpTask;
  }

  afterEach(async () => {
    await auditRepo.createQueryBuilder().delete().execute();
    await convRepo.createQueryBuilder().delete().execute();
    await agentRepo.createQueryBuilder().delete().execute();
    await assignmentRepo.createQueryBuilder().delete().execute();
    await taskRepo.createQueryBuilder().delete().execute();
    await roleRepo.createQueryBuilder().delete().execute();
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

    const taskEvents$ = consumeSse<WireEvent>(
      app,
      `/api/task/${task.id}/events`,
      authHeaders,
      2,
    );
    const companyEvents$ = consumeSse<WireEvent>(
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
    // live 'cancelled' transition — both entity:'task' state_change WireEvents.
    expect(taskEvents).toHaveLength(2);
    expect(taskEvents[0]).toMatchObject({
      type: 'audit',
      event: {
        eventType: 'state_change',
        payload: { entity: 'task', summary: { id: task.id, status: 'ready' } },
      },
    });
    expect(taskEvents[1]).toMatchObject({
      type: 'audit',
      event: {
        eventType: 'state_change',
        payload: {
          entity: 'task',
          newStatus: 'cancelled',
          summary: { id: task.id, status: 'cancelled' },
        },
      },
    });

    // Company stream: primed with a company signal + the task's current state,
    // then the live transition — all state_change WireEvents.
    expect(companyEvents).toHaveLength(3);
    expect(companyEvents[0]).toMatchObject({
      type: 'audit',
      event: { eventType: 'state_change', payload: { entity: 'company' } },
    });
    expect(companyEvents[1]).toMatchObject({
      type: 'audit',
      event: {
        eventType: 'state_change',
        payload: { entity: 'task', summary: { id: task.id, status: 'ready' } },
      },
    });
    expect(companyEvents[2]).toMatchObject({
      type: 'audit',
      event: {
        eventType: 'state_change',
        payload: {
          entity: 'task',
          newStatus: 'cancelled',
          summary: { id: task.id, status: 'cancelled' },
        },
      },
    });
  }, 15000);

  // The web UI's live activity view renders one list per entity kind, each
  // seeded from priming and kept current by the live rows (ADR-023). Both
  // halves are asserted here because a mismatch between them is invisible
  // until a list quietly stops updating.
  describe('the five company-stream entity kinds', () => {
    let company: TcpCompany;
    let role: TcpRole;

    beforeEach(async () => {
      company = await createCompany();
      role = await roleRepo.save(
        roleRepo.create({
          companyId: company.id,
          slug: `analyst-${Date.now()}`,
          name: 'Analyst',
          description: 'Analyses things',
          rolePrompt: 'Analyse.',
          knowledgeDomains: [],
        }),
      );
    });

    it('primes one row per entity kind: company, task, agent, assignment, enquiry', async () => {
      await createTask(company.id);

      // An active agent on its own (chat-mode) assignment.
      const chat = await assignmentRepo.save(
        assignmentRepo.create({
          companyId: company.id,
          roleId: role.id,
          taskId: null,
          agentId: null,
          mode: 'chat',
          status: 'in-progress',
          prompt: 'Talk',
          materials: [],
          expected: [],
        }),
      );
      await agentRepo.save(
        agentRepo.create({
          companyId: company.id,
          roleId: role.id,
          assignmentId: chat.id,
          initialPrompt: 'Talk',
          requiredToolCalls: [],
          status: AgentStatus.Running,
        }),
      );

      // An orphan consultee assignment — the consultations list.
      await assignmentRepo.save(
        assignmentRepo.create({
          companyId: company.id,
          roleId: role.id,
          taskId: null,
          agentId: null,
          mode: 'consultee',
          status: 'in-progress',
          prompt: 'Advise',
          materials: [],
          expected: [],
        }),
      );

      // An enquiry awaiting a reply.
      await convRepo.save(
        convRepo.create({
          slug: `analyst-${Date.now()}`,
          companyId: company.id,
          roleName: 'Analyst',
          roleId: role.id,
          agentId: null,
          question: 'Which vendor?',
          context: null,
          status: 'awaiting_user',
          routedToIdentifiers: [],
        }),
      );

      const events = await consumeSse<WireEvent>(
        app,
        `/api/company/${company.id}/events`,
        { Authorization: `Bearer ${jwt}` },
        5,
      );

      expect(entitiesOf(events)).toEqual([
        'company',
        'task',
        'agent',
        'assignment',
        'enquiry',
      ]);
      // Every list row renders from its summary, so priming must carry one.
      for (const event of events.slice(1)) {
        expect(event.type).toBe('audit');
        if (event.type !== 'audit') continue;
        expect(event.event.payload.summary).toBeDefined();
        expect(event.event.payload.reason).toBe('replay');
      }
    }, 20000);

    it('relays an agent state change and an enquiry open, then its close', async () => {
      const assignment = await assignmentRepo.save(
        assignmentRepo.create({
          companyId: company.id,
          roleId: role.id,
          taskId: null,
          agentId: null,
          mode: 'chat',
          status: 'in-progress',
          prompt: 'Talk',
          materials: [],
          expected: [],
        }),
      );
      const agent = await agentRepo.save(
        agentRepo.create({
          companyId: company.id,
          roleId: role.id,
          assignmentId: assignment.id,
          initialPrompt: 'Talk',
          requiredToolCalls: [],
          status: AgentStatus.Running,
        }),
      );

      // Priming: company + agent. Then the pause writes an agent row and an
      // enquiry row; the reply writes the enquiry's close. Five in all.
      const events$ = consumeSse<WireEvent>(
        app,
        `/api/company/${company.id}/events`,
        { Authorization: `Bearer ${jwt}` },
        5,
        10000,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));

      const paused = await request(app.getHttpServer())
        .post('/internal/pause')
        .set('X-Internal-Api-Key', INTERNAL_KEY)
        .send({
          type: 'user_input',
          agentId: agent.id,
          question: 'Which vendor?',
        })
        .expect(201);
      const slug = (paused.body as { slug: string }).slug;

      await request(app.getHttpServer())
        .post(`/api/conversation/${slug}/reply`)
        .set('Authorization', `Bearer ${jwt}`)
        .send({ content: 'The second one.' })
        .expect(201);

      const events = await events$;

      expect(entitiesOf(events)).toEqual([
        'company',
        'agent',
        'agent',
        'enquiry',
        'enquiry',
      ]);
      expect(events[2]).toMatchObject({
        type: 'audit',
        event: {
          agentId: agent.id,
          payload: { entity: 'agent', newStatus: AgentStatus.Paused },
        },
      });
      // The enquiry rows must stay agent-less, or the publisher routes them
      // to the agent channel and the enquiries list never updates.
      expect(events[3]).toMatchObject({
        type: 'audit',
        event: {
          agentId: null,
          payload: {
            entity: 'enquiry',
            newStatus: 'awaiting_user',
            summary: { slug, status: 'awaiting_user' },
          },
        },
      });
      expect(events[4]).toMatchObject({
        type: 'audit',
        event: {
          agentId: null,
          payload: {
            entity: 'enquiry',
            newStatus: 'closed',
            reason: 'replied',
            summary: { slug, status: 'closed' },
          },
        },
      });
    }, 20000);

    it('relays an assignment change', async () => {
      const task = await createTask(company.id);
      await assignmentRepo.save(
        assignmentRepo.create({
          companyId: company.id,
          roleId: role.id,
          taskId: task.id,
          agentId: null,
          mode: 'implement',
          status: 'ready',
          orderIndex: 0,
          prompt: 'Do step one',
          materials: [],
          expected: [],
        }),
      );

      // Priming: company + task. Cancelling then writes the task's own row
      // and one per assignment.
      const events$ = consumeSse<WireEvent>(
        app,
        `/api/company/${company.id}/events`,
        { Authorization: `Bearer ${jwt}` },
        4,
        10000,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));

      await request(app.getHttpServer())
        .post(`/api/task/${task.id}/cancel`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(202);

      const events = await events$;
      expect(entitiesOf(events)).toContain('assignment');
      const assignmentRow = events.find(
        (e) => e.type === 'audit' && e.event.payload.entity === 'assignment',
      );
      expect(assignmentRow).toMatchObject({
        type: 'audit',
        event: {
          payload: {
            entity: 'assignment',
            summary: { mode: 'implement', roleId: role.id },
          },
        },
      });
    }, 20000);
  });

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
