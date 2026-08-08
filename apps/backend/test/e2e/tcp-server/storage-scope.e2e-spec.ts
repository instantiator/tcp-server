import {
  AgentStatus,
  TcpAgent,
  TcpAssignment,
  TcpCompany,
  TcpRole,
  TcpTask,
} from '@tcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../../apps/tcp-server/src/app.module';

const INTERNAL_KEY = process.env.INTERNAL_API_KEY ?? 'e2e-test-internal-key';

/**
 * e2e coverage for the assignment-scoped storage support added in
 * docs/prompts/010.2.6: the `GET /internal/agent/:id/storage-scope` resolution
 * and the `/internal/storage/append` round-trip that lands a working file under
 * the correct prefix. Runs against the full tcp-server app (real DB + MinIO).
 *
 * The qa-mode *refusal* to mutate lives in the tcp-mcp-storage tool handler
 * (unit-tested there); here we assert the server hands qa callers a read-only
 * scope pointed at the target assignment — the data that gate relies on.
 */
describe('Storage scope + append (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<TcpCompany>;
  let roleRepo: Repository<TcpRole>;
  let taskRepo: Repository<TcpTask>;
  let assignmentRepo: Repository<TcpAssignment>;
  let agentRepo: Repository<TcpAgent>;

  let company: TcpCompany;
  let role: TcpRole;
  let task: TcpTask;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    // Listening, not just init() — see agent.e2e-spec.ts for why.
    await app.listen(0);
    companyRepo = moduleFixture.get(getRepositoryToken(TcpCompany));
    roleRepo = moduleFixture.get(getRepositoryToken(TcpRole));
    taskRepo = moduleFixture.get(getRepositoryToken(TcpTask));
    assignmentRepo = moduleFixture.get(getRepositoryToken(TcpAssignment));
    agentRepo = moduleFixture.get(getRepositoryToken(TcpAgent));

    company = await companyRepo.save(
      companyRepo.create({
        slug: `scope-co-${Date.now()}`,
        name: 'Scope Co',
        description: 'test',
      }),
    );
    role = await roleRepo.save(
      roleRepo.create({
        companyId: company.id,
        slug: 'analyst',
        name: 'analyst',
        description: 'x',
      }),
    );
    task = await taskRepo.save(
      taskRepo.create({
        companyId: company.id,
        request: 'do it',
        shortcode: '000',
        status: 'in-progress',
      }),
    );
  });

  afterAll(async () => {
    await agentRepo.createQueryBuilder().delete().execute();
    await assignmentRepo.createQueryBuilder().delete().execute();
    await taskRepo.createQueryBuilder().delete().execute();
    await roleRepo.createQueryBuilder().delete().execute();
    await companyRepo.delete(company.id);
    await app.close();
  });

  async function seedAgent(assignmentId: UUID): Promise<TcpAgent> {
    return agentRepo.save(
      agentRepo.create({
        companyId: company.id,
        roleId: role.id,
        assignmentId,
        status: AgentStatus.Running,
        initialPrompt: 'x',
      }),
    );
  }

  it('resolves an implement assignment scope and round-trips a working file via append', async () => {
    const assignment = await assignmentRepo.save(
      assignmentRepo.create({
        companyId: company.id,
        roleId: role.id,
        taskId: task.id,
        mode: 'implement',
        orderIndex: 0,
        prompt: 'work',
        status: 'in-progress',
        materials: [{ type: 'inline-text', value: 'a hint' }],
      }),
    );
    const agent = await seedAgent(assignment.id);

    const scopeRes = await request(app.getHttpServer())
      .get(`/internal/agent/${agent.id}/storage-scope`)
      .set('X-Internal-Api-Key', INTERNAL_KEY);
    expect(scopeRes.status).toBe(200);
    const expectedPrefix = `${company.slug}/tasks/${task.id}/assignments/0/working/`;
    expect(scopeRes.body).toMatchObject({
      mode: 'implement',
      readOnly: false,
      workingPrefix: expectedPrefix,
      materials: [{ name: 'inline-1', key: null, inlineText: 'a hint' }],
    });

    const key = `${expectedPrefix}report.md`;
    const appendRes = await request(app.getHttpServer())
      .post('/internal/storage/append')
      .set('X-Internal-Api-Key', INTERNAL_KEY)
      .send({
        path: key,
        content: '# Report\n',
        originators: { agent: agent.id },
      });
    expect([200, 201]).toContain(appendRes.status);
    expect((appendRes.body as { created: boolean }).created).toBe(true);

    const readRes = await request(app.getHttpServer())
      .post('/internal/storage/read')
      .set('X-Internal-Api-Key', INTERNAL_KEY)
      .send({ path: key });
    expect((readRes.body as { content: string }).content).toBe('# Report\n');
  });

  it('renames a working file via /internal/storage/move and 404s reading the old key', async () => {
    const assignment = await assignmentRepo.save(
      assignmentRepo.create({
        companyId: company.id,
        roleId: role.id,
        taskId: task.id,
        mode: 'implement',
        orderIndex: 2,
        prompt: 'work',
        status: 'in-progress',
      }),
    );
    const agent = await seedAgent(assignment.id);
    const prefix = `${company.slug}/tasks/${task.id}/assignments/2/working/`;
    const source = `${prefix}draft.md`;
    const destination = `${prefix}final.md`;

    await request(app.getHttpServer())
      .post('/internal/storage/append')
      .set('X-Internal-Api-Key', INTERNAL_KEY)
      .send({
        path: source,
        content: '# Draft\n',
        originators: { agent: agent.id },
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/internal/storage/move')
      .set('X-Internal-Api-Key', INTERNAL_KEY)
      .send({ source, destination, originators: { agent: agent.id } })
      .expect(201);

    await request(app.getHttpServer())
      .post('/internal/storage/read')
      .set('X-Internal-Api-Key', INTERNAL_KEY)
      .send({ path: source })
      .expect(404);

    const readRes = await request(app.getHttpServer())
      .post('/internal/storage/read')
      .set('X-Internal-Api-Key', INTERNAL_KEY)
      .send({ path: destination });
    expect((readRes.body as { content: string }).content).toBe('# Draft\n');
  });

  it('hands a qa caller a read-only scope pointed at the target assignment', async () => {
    const target = await assignmentRepo.save(
      assignmentRepo.create({
        companyId: company.id,
        roleId: role.id,
        taskId: task.id,
        mode: 'implement',
        orderIndex: 1,
        prompt: 'work',
        status: 'in-qa',
      }),
    );
    const qa = await assignmentRepo.save(
      assignmentRepo.create({
        companyId: company.id,
        roleId: role.id,
        taskId: task.id,
        mode: 'qa',
        prompt: 'review',
        status: 'in-progress',
        targetAssignmentId: target.id,
      }),
    );
    const qaAgent = await seedAgent(qa.id);

    const scopeRes = await request(app.getHttpServer())
      .get(`/internal/agent/${qaAgent.id}/storage-scope`)
      .set('X-Internal-Api-Key', INTERNAL_KEY);
    expect(scopeRes.status).toBe(200);
    expect(scopeRes.body).toMatchObject({
      mode: 'qa',
      readOnly: true,
      workingPrefix: `${company.slug}/tasks/${task.id}/assignments/1/working/`,
    });
  });
});
