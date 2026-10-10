import {
  AgentStatus,
  CompanyUser,
  Conversation,
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
import { Repository } from 'typeorm';
import { AppModule } from '../../../apps/tcp-server/src/app.module';
import { makeTestJwt } from '../helpers/test-jwt';
import { seedMembership } from '../helpers/seed-membership';

/**
 * Membership enforcement across every user-facing route family (002.05,
 * ADR-011's phase-02 amendment).
 *
 * The point of the suite is the **pair**: a member succeeds and a non-member
 * is refused on the same route. A test that only proves the happy path proves
 * nothing about authorization, and one that only proves the refusal can pass
 * against a route that is simply broken.
 *
 * Alice and Bob each own a company. Bob is the non-member throughout; his
 * token is valid, which is exactly the point — authentication was never the
 * gap.
 */
describe('Membership authorization (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<TcpCompany>;
  let roleRepo: Repository<TcpRole>;
  let taskRepo: Repository<TcpTask>;
  let assignmentRepo: Repository<TcpAssignment>;
  let agentRepo: Repository<TcpAgent>;
  let conversationRepo: Repository<Conversation>;
  let companyUserRepo: Repository<CompanyUser>;

  const aliceJwt = makeTestJwt({ sub: 'alice', email: 'alice@example.com' });
  const bobJwt = makeTestJwt({ sub: 'bob', email: 'bob@example.com' });
  /** Named in `.env.testing`'s TCP_ADMIN_IDENTIFIERS. */
  const adminJwt = makeTestJwt({ sub: 'e2e-admin' });

  const stamp = Date.now();
  const aliceSlug = `member-alice-${stamp}`;
  const bobSlug = `member-bob-${stamp}`;
  const emailSlug = `member-email-${stamp}`;

  let alice: TcpCompany;
  let bob: TcpCompany;
  /** Alice reaches this one only through an email-keyed membership row. */
  let emailOnly: TcpCompany;
  let aliceRole: TcpRole;
  let aliceTask: TcpTask;
  let aliceAssignment: TcpAssignment;
  let aliceAgent: TcpAgent;
  let aliceConversation: Conversation;

  /** `GET`s `path` as both identities, asserting the member/non-member pair. */
  const expectScoped = async (
    path: string,
    memberStatus = 200,
  ): Promise<void> => {
    await request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${aliceJwt}`)
      .expect(memberStatus);
    await request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${bobJwt}`)
      .expect(403);
  };

  const makeCompany = async (slug: string): Promise<TcpCompany> =>
    companyRepo.save(
      companyRepo.create({ slug, name: slug, description: 'membership test' }),
    );

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    // Listening, not just init() — see agent.e2e-spec.ts for why.
    await app.listen(0);
    companyRepo = module.get(getRepositoryToken(TcpCompany));
    roleRepo = module.get(getRepositoryToken(TcpRole));
    taskRepo = module.get(getRepositoryToken(TcpTask));
    assignmentRepo = module.get(getRepositoryToken(TcpAssignment));
    agentRepo = module.get(getRepositoryToken(TcpAgent));
    conversationRepo = module.get(getRepositoryToken(Conversation));
    companyUserRepo = module.get(getRepositoryToken(CompanyUser));

    alice = await makeCompany(aliceSlug);
    bob = await makeCompany(bobSlug);
    emailOnly = await makeCompany(emailSlug);
    await seedMembership(companyUserRepo, alice.id, 'alice');
    await seedMembership(companyUserRepo, bob.id, 'bob');
    // Keyed by email, not by `sub` — the path that fails silently when a
    // lookup matches on `sub` alone.
    await seedMembership(companyUserRepo, emailOnly.id, 'alice@example.com');

    aliceRole = await roleRepo.save(
      roleRepo.create({
        companyId: alice.id,
        company: alice,
        slug: 'analyst',
        name: 'Analyst',
        description: 'Analyses',
        systemPromptTemplate: 'You are {{name}}.',
        knowledgeDomains: [],
        mcpServerList: [],
      }),
    );
    aliceTask = await taskRepo.save(
      taskRepo.create({
        companyId: alice.id,
        company: alice,
        request: 'A task in Alice’s company',
        shortcode: `MEM-${stamp}`,
        materials: [],
        expected: [],
      }),
    );
    aliceAssignment = await assignmentRepo.save(
      assignmentRepo.create({
        companyId: alice.id,
        roleId: aliceRole.id,
        taskId: aliceTask.id,
        mode: 'implement',
        prompt: 'Do the work',
        status: 'ready',
      }),
    );
    aliceAgent = await agentRepo.save(
      agentRepo.create({
        companyId: alice.id,
        roleId: aliceRole.id,
        assignmentId: aliceAssignment.id,
        status: AgentStatus.Idle,
        initialPrompt: '',
      }),
    );
    aliceConversation = await conversationRepo.save(
      conversationRepo.create({
        slug: `analyst-${stamp}`,
        companyId: alice.id,
        roleName: 'Analyst',
        roleId: aliceRole.id,
        agentId: null,
        question: 'Which way?',
        status: 'awaiting_user',
        routedToIdentifiers: [],
      }),
    );
  });

  afterAll(async () => {
    // Only this suite's companies — the e2e database is shared. Roles, tasks,
    // assignments, agents, conversations and memberships cascade from these.
    for (const company of [alice, bob, emailOnly]) {
      await companyRepo.delete(company.id);
    }
    await app.close();
  });

  describe('companies', () => {
    it('is reachable by its member and refused to a non-member', () =>
      expectScoped(`/api/company/${alice.id}`));

    it('accepts a slug as readily as a UUID', () =>
      expectScoped(`/api/company/${aliceSlug}`));

    it('refuses a non-member the company role list', () =>
      expectScoped(`/api/company/${alice.id}/roles`));

    it('refuses a non-member the membership list', () =>
      expectScoped(`/api/company/${alice.id}/users`));

    it('refuses a non-member an update', () =>
      request(app.getHttpServer())
        .put(`/api/company/${alice.id}`)
        .set('Authorization', `Bearer ${bobJwt}`)
        .send({ description: 'not yours' })
        .expect(403));

    it('refuses a non-member a delete', () =>
      request(app.getHttpServer())
        .delete(`/api/company/${alice.id}`)
        .set('Authorization', `Bearer ${bobJwt}`)
        .expect(403));

    // The data-shape bug ADR-011 warns about: a membership row keyed by email
    // must grant access as readily as one keyed by the OIDC `sub`.
    it('honours a membership keyed by email rather than sub', () =>
      request(app.getHttpServer())
        .get(`/api/company/${emailOnly.id}`)
        .set('Authorization', `Bearer ${aliceJwt}`)
        .expect(200));

    it('still refuses that company to an unrelated caller', () =>
      request(app.getHttpServer())
        .get(`/api/company/${emailOnly.id}`)
        .set('Authorization', `Bearer ${bobJwt}`)
        .expect(403));
  });

  describe('roles', () => {
    it('scopes a role fetched by its own id', () =>
      expectScoped(`/api/role/${aliceRole.id}`));

    it('scopes a role reached through its company slug', () =>
      expectScoped(`/api/company/${alice.id}/roles/by-slug/analyst`));

    it('refuses creating a role in another company', () =>
      request(app.getHttpServer())
        .post('/api/role')
        .set('Authorization', `Bearer ${bobJwt}`)
        .send({
          companyId: alice.id,
          slug: 'intruder',
          name: 'Intruder',
          description: 'Should not exist',
          systemPromptTemplate: 'You are {{name}}.',
          knowledgeDomains: [],
          mcpServerList: [],
        })
        .expect(403));
  });

  describe('tasks', () => {
    it('scopes a task by its id', () =>
      expectScoped(`/api/task/${aliceTask.id}`));

    it('scopes a task history', () =>
      expectScoped(`/api/task/${aliceTask.id}/history`));

    it('scopes the company task list', () =>
      expectScoped(`/api/task?companyId=${alice.id}`));

    it('refuses creating a task in another company', () =>
      request(app.getHttpServer())
        .post('/api/task')
        .set('Authorization', `Bearer ${bobJwt}`)
        .send({ companyId: alice.id, request: 'Not yours' })
        .expect(403));

    it('refuses starting another company’s task', () =>
      request(app.getHttpServer())
        .post(`/api/task/${aliceTask.id}/start`)
        .set('Authorization', `Bearer ${bobJwt}`)
        .expect(403));

    it('refuses cancelling another company’s task', () =>
      request(app.getHttpServer())
        .post(`/api/task/${aliceTask.id}/cancel`)
        .set('Authorization', `Bearer ${bobJwt}`)
        .expect(403));

    it('refuses an unfiltered task list', () =>
      request(app.getHttpServer())
        .get('/api/task')
        .set('Authorization', `Bearer ${bobJwt}`)
        .expect(400));
  });

  describe('assignments', () => {
    it('scopes an assignment by its id', () =>
      expectScoped(`/api/assignment/${aliceAssignment.id}`));

    // Reached indirectly: the filter names a task, and the task names the
    // company. This is the shape a per-controller check would have missed.
    it('scopes an assignment list filtered by another company’s task', () =>
      expectScoped(`/api/assignment?taskId=${aliceTask.id}`));

    it('scopes an assignment list filtered by company', () =>
      expectScoped(`/api/assignment?companyId=${alice.id}`));

    // `taskId=null` is the orphan-assignment sentinel, not an id, so it names
    // no company on its own and must not become an unscoped list.
    it('refuses an orphan-assignment list that names no company', () =>
      request(app.getHttpServer())
        .get('/api/assignment?taskId=null')
        .set('Authorization', `Bearer ${bobJwt}`)
        .expect(400));
  });

  // Only the refusals are asserted: a permitted stream stays open by design,
  // so a member request would hang rather than return. The refusal is the half
  // that matters — an SSE route that ignored its guard would leak a company's
  // whole live activity, and would look identical to a working stream.
  describe('event streams', () => {
    it.each([
      ['company', () => `/api/company/${alice.id}/events`],
      ['task', () => `/api/task/${aliceTask.id}/events`],
      ['agent', () => `/api/agent/${aliceAgent.id}/events`],
    ])('refuses a non-member the %s stream', (_kind, path) =>
      request(app.getHttpServer())
        .get(path())
        .set('Authorization', `Bearer ${bobJwt}`)
        .expect(403),
    );
  });

  describe('agents', () => {
    it('scopes an agent by its id', () =>
      expectScoped(`/api/agent/${aliceAgent.id}`));

    it('scopes an agent history', () =>
      expectScoped(`/api/agent/${aliceAgent.id}/history`));

    it('scopes an agent list filtered by another company’s role', () =>
      expectScoped(`/api/agent?roleId=${aliceRole.id}`));

    it('scopes an agent list filtered by another company’s assignment', () =>
      expectScoped(`/api/agent?assignmentId=${aliceAssignment.id}`));

    it('refuses starting a chat agent in another company', () =>
      request(app.getHttpServer())
        .post('/api/agent/chat/start')
        .set('Authorization', `Bearer ${bobJwt}`)
        .send({ companyId: alice.id, roleId: aliceRole.id })
        .expect(403));

    it('refuses messaging another company’s agent', () =>
      request(app.getHttpServer())
        .post(`/api/agent/${aliceAgent.id}/message`)
        .set('Authorization', `Bearer ${bobJwt}`)
        .send({ message: 'hello' })
        .expect(403));

    it('refuses deleting another company’s agent', () =>
      request(app.getHttpServer())
        .delete(`/api/agent/${aliceAgent.id}`)
        .set('Authorization', `Bearer ${bobJwt}`)
        .expect(403));
  });

  describe('conversations', () => {
    it('scopes a conversation by its slug', () =>
      expectScoped(`/api/conversation/${aliceConversation.slug}`));

    it('scopes the conversation list', () =>
      expectScoped(`/api/conversation?companyId=${alice.id}`));

    it('refuses replying to another company’s conversation', () =>
      request(app.getHttpServer())
        .post(`/api/conversation/${aliceConversation.slug}/reply`)
        .set('Authorization', `Bearer ${bobJwt}`)
        .send({ content: 'not mine to answer' })
        .expect(403));

    it('refuses an unfiltered conversation list', () =>
      request(app.getHttpServer())
        .get('/api/conversation')
        .set('Authorization', `Bearer ${bobJwt}`)
        .expect(400));
  });

  describe('knowledge', () => {
    it('scopes a role’s knowledge listing', () =>
      expectScoped(`/api/role/${aliceRole.id}/knowledge`));

    it('scopes a role’s knowledge status', () =>
      expectScoped(`/api/role/${aliceRole.id}/knowledge/status`));

    it('scopes a company’s knowledge listing', () =>
      expectScoped(`/api/company/${alice.id}/knowledge`));

    it('refuses reindexing another company’s knowledge', () =>
      request(app.getHttpServer())
        .post(`/api/company/${alice.id}/knowledge/reindex`)
        .set('Authorization', `Bearer ${bobJwt}`)
        .expect(403));
  });

  describe('storage', () => {
    // The company slug is the first segment of every object key. Alice gets a
    // 404 because the object doesn't exist — she was allowed to ask.
    it('scopes a download by the company prefix of its key', () =>
      expectScoped(
        `/api/storage?path=${aliceSlug}/knowledge/shared/x.md`,
        404,
      ));

    it('refuses an upload into another company’s prefix', () =>
      request(app.getHttpServer())
        .post(`/api/storage?path=${aliceSlug}/knowledge/shared/x.md`)
        .set('Authorization', `Bearer ${bobJwt}`)
        .attach('file', Buffer.from('# hello'), 'x.md')
        .expect(403));

    // Alice's 404 is the storage answer for a prefix holding no documents —
    // she passed the guard and was refused by the store, not by membership.
    it('scopes validation by the company prefix', async () => {
      await request(app.getHttpServer())
        .post('/api/storage/validate')
        .set('Authorization', `Bearer ${aliceJwt}`)
        .send({ path: `${aliceSlug}/knowledge/shared/` })
        .expect(404);
      await request(app.getHttpServer())
        .post('/api/storage/validate')
        .set('Authorization', `Bearer ${bobJwt}`)
        .send({ path: `${aliceSlug}/knowledge/shared/` })
        .expect(403);
    });

    // A glob in the company segment spans every company: refused outright
    // rather than quietly filtered down to what the caller may see.
    it('refuses a glob that spans companies', () =>
      request(app.getHttpServer())
        .post('/api/storage/validate')
        .set('Authorization', `Bearer ${aliceJwt}`)
        .send({ path: '*/knowledge/shared/*.md' })
        .expect(403));
  });

  describe('administrator-only surfaces', () => {
    it('refuses ?all=true to an ordinary member', () =>
      request(app.getHttpServer())
        .get('/api/company?all=true')
        .set('Authorization', `Bearer ${aliceJwt}`)
        .expect(403));

    it('allows ?all=true to an administrator', () =>
      request(app.getHttpServer())
        .get('/api/company?all=true')
        .set('Authorization', `Bearer ${adminJwt}`)
        .expect(200));

    it('refuses the shutdown status to an ordinary member', () =>
      request(app.getHttpServer())
        .get('/api/system/shutdown')
        .set('Authorization', `Bearer ${aliceJwt}`)
        .expect(403));

    it('refuses the combined system health to an ordinary member', () =>
      request(app.getHttpServer())
        .get('/api/system/health')
        .set('Authorization', `Bearer ${aliceJwt}`)
        .expect(403));

    it('gives an administrator the health of every service', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/system/health')
        .set('Authorization', `Bearer ${adminJwt}`)
        .expect(200);
      const body = res.body as { services: { name: string }[] };
      expect(body.services.map((service) => service.name)).toEqual([
        'tcp-server',
        'tcp-agent',
        'tcp-mcp-storage',
        'tcp-mcp-memory',
        'tcp-mcp-interactions',
        'tcp-mcp-tasks',
      ]);
    });

    it('tells an ordinary member they are not an administrator, with the shutdown state', () =>
      request(app.getHttpServer())
        .get('/api/system/status')
        .set('Authorization', `Bearer ${aliceJwt}`)
        .expect(200)
        .expect({ admin: false, shutdown: { state: 'idle', restart: false } }));

    it('tells an administrator they are one', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/system/status')
        .set('Authorization', `Bearer ${adminJwt}`)
        .expect(200);
      expect(res.body).toMatchObject({ admin: true });
    });

    it('refuses the system status without a token', () =>
      request(app.getHttpServer()).get('/api/system/status').expect(401));

    it('lets an administrator reach a company they are not a member of', () =>
      request(app.getHttpServer())
        .get(`/api/company/${alice.id}`)
        .set('Authorization', `Bearer ${adminJwt}`)
        .expect(200));
  });

  describe('the internal trust boundary is untouched', () => {
    // `/internal/*` is guarded by the shared API key, not a JWT, and is a
    // different trust boundary: tcp-agent has no membership and needs none.
    it('serves an internal caller a company it holds no membership in', () =>
      request(app.getHttpServer())
        .get(`/internal/company/${alice.id}/roles`)
        .set('X-Internal-Api-Key', process.env.INTERNAL_API_KEY ?? '')
        .expect(200));

    it('still refuses an internal call without the key', () =>
      request(app.getHttpServer())
        .get(`/internal/company/${alice.id}/roles`)
        .expect(401));
  });
});
