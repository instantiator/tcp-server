import {
  assignmentWorkingKey,
  LcpAssignment,
  LcpCompany,
  LcpRole,
  LcpTask,
  taskCompletedPrefix,
} from '@lcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../../apps/lcp-server/src/app.module';
import { StorageService } from '../../../apps/lcp-server/src/storage/storage.service';
import { makeTestJwt } from '../helpers/test-jwt';

const INTERNAL_KEY = process.env.INTERNAL_API_KEY ?? 'e2e-test-internal-key';

/**
 * End-to-end coverage of the task orchestration flow (010.2.7), driving the
 * **internal endpoints directly** to stand in for agent behaviour — no LLM.
 * Runs against the full lcp-server app (real DB + MinIO + Redis). This is the
 * plan's primary integration coverage: the real state machine, atomic claims,
 * file promotion, finalisation, QA reject/retry, exhaustion, and failure
 * propagation are all exercised over HTTP.
 */
describe('Task orchestration lifecycle (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<LcpCompany>;
  let roleRepo: Repository<LcpRole>;
  let taskRepo: Repository<LcpTask>;
  let assignmentRepo: Repository<LcpAssignment>;
  let storage: StorageService;
  let jwt: string;

  let company: LcpCompany;
  let role: LcpRole;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    companyRepo = moduleFixture.get(getRepositoryToken(LcpCompany));
    roleRepo = moduleFixture.get(getRepositoryToken(LcpRole));
    taskRepo = moduleFixture.get(getRepositoryToken(LcpTask));
    assignmentRepo = moduleFixture.get(getRepositoryToken(LcpAssignment));
    storage = moduleFixture.get(StorageService);
    jwt = makeTestJwt();

    company = await companyRepo.save(
      companyRepo.create({
        slug: `orch-co-${Date.now()}`,
        name: 'Orchestration Co',
        description: 'x',
      }),
    );
    role = await roleRepo.save(
      roleRepo.create({
        companyId: company.id,
        slug: 'worker',
        name: 'worker',
        description: 'x',
      }),
    );
  });

  afterEach(async () => {
    await assignmentRepo.createQueryBuilder().delete().execute();
    await taskRepo.createQueryBuilder().delete().execute();
  });

  afterAll(async () => {
    await roleRepo.delete(role.id);
    await companyRepo.delete(company.id);
    await app.close();
  });

  // --- helpers --------------------------------------------------------------

  /** Creates a task (with the worker role as planner) and starts it. */
  async function createAndStart(): Promise<UUID> {
    const created = await request(app.getHttpServer())
      .post('/api/task')
      .set('Authorization', `Bearer ${jwt}`)
      .send({
        companyId: company.id,
        request: 'Produce a report',
        plannerRoleId: role.id,
      })
      .expect(201);
    const taskId = (created.body as LcpTask).id;
    await request(app.getHttpServer())
      .post(`/api/task/${taskId}/start`)
      .set('Authorization', `Bearer ${jwt}`)
      .expect(202);
    return taskId;
  }

  async function agentIdFor(assignmentId: UUID): Promise<UUID> {
    const a = await assignmentRepo.findOneByOrFail({ id: assignmentId });
    return a.agentId!;
  }

  async function planAssignment(taskId: UUID): Promise<LcpAssignment> {
    return assignmentRepo.findOneByOrFail({ taskId, mode: 'plan' });
  }

  async function step(
    taskId: UUID,
    orderIndex: number,
  ): Promise<LcpAssignment> {
    return assignmentRepo.findOneByOrFail({
      taskId,
      mode: 'implement',
      orderIndex,
    });
  }

  async function qaAssignment(targetId: UUID): Promise<LcpAssignment> {
    return assignmentRepo.findOneByOrFail({
      targetAssignmentId: targetId,
      mode: 'qa',
      status: 'in-progress',
    });
  }

  /** Submits a two-step plan as the planning agent. */
  async function submitPlan(taskId: UUID, steps = 2): Promise<void> {
    const planAgentId = await agentIdFor((await planAssignment(taskId)).id);
    const assignments = Array.from({ length: steps }, (_, i) => ({
      prompt: `Step ${i}`,
      role: role.slug,
      expected: [{ type: 'assignment-working-path' as const, value: 'out.md' }],
    }));
    await request(app.getHttpServer())
      .post(`/internal/task/${taskId}/plan`)
      .set('X-Internal-Api-Key', INTERNAL_KEY)
      .send({ agentId: planAgentId, assignments })
      .expect(201);
  }

  /** Writes the expected working file, then completes the implement assignment. */
  async function completeStep(
    taskId: UUID,
    orderIndex: number,
    expectStatus = 200,
  ): Promise<{ assignmentId: UUID; agentId: UUID }> {
    const assignment = await step(taskId, orderIndex);
    const agentId = await agentIdFor(assignment.id);
    await storage.putByKey(
      assignmentWorkingKey(company.slug, taskId, orderIndex, 'out.md'),
      Buffer.from(`# Output for step ${orderIndex}\n`),
      'text/markdown',
    );
    await request(app.getHttpServer())
      .post(`/internal/assignment/${assignment.id}/complete`)
      .set('X-Internal-Api-Key', INTERNAL_KEY)
      .send({
        agentId,
        summary: `step ${orderIndex} done`,
        prepared: [{ type: 'assignment-working-path', value: 'out.md' }],
      })
      .expect(expectStatus);
    return { assignmentId: assignment.id, agentId };
  }

  /** Runs the QA agent's verdict for a target assignment. */
  async function assure(
    targetId: UUID,
    qa: 'accept' | 'reject',
    feedback?: string,
  ): Promise<void> {
    const qaAgentId = await agentIdFor((await qaAssignment(targetId)).id);
    await request(app.getHttpServer())
      .post(`/internal/assignment/${targetId}/assure`)
      .set('X-Internal-Api-Key', INTERNAL_KEY)
      .send({ agentId: qaAgentId, qa, feedback })
      .expect(200);
  }

  // --- scenarios ------------------------------------------------------------

  it('runs the full lifecycle to a succeeded task with promoted files', async () => {
    const taskId = await createAndStart();
    expect((await taskRepo.findOneByOrFail({ id: taskId })).status).toBe(
      'planning',
    );

    await submitPlan(taskId, 2);
    // Planning is claimed and step 0 dispatched.
    expect((await taskRepo.findOneByOrFail({ id: taskId })).status).toBe(
      'in-progress',
    );
    expect((await step(taskId, 0)).status).toBe('in-progress');

    // Step 0: complete → in-qa → accept → succeeded, step 1 dispatched.
    const s0 = await completeStep(taskId, 0);
    expect((await step(taskId, 0)).status).toBe('in-qa');
    await assure(s0.assignmentId, 'accept');
    expect((await step(taskId, 0)).status).toBe('succeeded');
    expect((await step(taskId, 1)).status).toBe('in-progress');

    // Step 1: complete → accept → finalisation.
    const s1 = await completeStep(taskId, 1);
    await assure(s1.assignmentId, 'accept');

    const task = await taskRepo.findOneByOrFail({ id: taskId });
    expect(task.status).toBe('succeeded');
    expect(task.completed).toEqual(
      expect.arrayContaining([
        { type: 'task-completed-path', value: 'out.md' },
      ]),
    );
    const completedFiles = await storage.listFiles(
      taskCompletedPrefix(company.slug, taskId),
    );
    expect(completedFiles.map((f) => f.name)).toContain('out.md');
  });

  it('returns a rejected assignment to the agent, then accepts the retry', async () => {
    const taskId = await createAndStart();
    await submitPlan(taskId, 1);

    const s0 = await completeStep(taskId, 0);
    await assure(s0.assignmentId, 'reject', 'Please add a summary section.');
    const afterReject = await step(taskId, 0);
    expect(afterReject.status).toBe('in-progress');
    expect(afterReject.qaAttempts).toBe(1);
    expect(afterReject.qaStatus).toBeNull();

    // Re-complete (same agent) → new QA cycle → accept → succeeded.
    await completeStep(taskId, 0);
    await assure(s0.assignmentId, 'accept');
    expect((await step(taskId, 0)).status).toBe('succeeded');
    expect((await taskRepo.findOneByOrFail({ id: taskId })).status).toBe(
      'succeeded',
    );
  });

  it('fails the task when QA rejects up to the attempt cap', async () => {
    // Cap the company at 1 QA attempt so a single rejection exhausts it.
    await companyRepo.update(company.id, { runConfig: { maxQaAttempts: 1 } });
    try {
      const taskId = await createAndStart();
      await submitPlan(taskId, 1);
      const s0 = await completeStep(taskId, 0);
      await assure(s0.assignmentId, 'reject', 'Not good enough.');

      expect((await step(taskId, 0)).status).toBe('failed');
      const task = await taskRepo.findOneByOrFail({ id: taskId });
      expect(task.status).toBe('failed');
      expect(task.failureReason).toBeTruthy();
    } finally {
      await companyRepo.update(company.id, { runConfig: null });
    }
  });

  it('propagates a planner agent failure to the task', async () => {
    const taskId = await createAndStart();
    const planAgentId = await agentIdFor((await planAssignment(taskId)).id);

    await request(app.getHttpServer())
      .post(`/internal/agent/${planAgentId}/fail`)
      .set('X-Internal-Api-Key', INTERNAL_KEY)
      .send({ reason: 'planner exploded' })
      .expect(204);

    const task = await taskRepo.findOneByOrFail({ id: taskId });
    expect(task.status).toBe('failed');
    expect(task.failureReason).toContain('planner failed');
  });

  it('lets only one of two concurrent completions win (atomic claim)', async () => {
    const taskId = await createAndStart();
    await submitPlan(taskId, 1);
    const assignment = await step(taskId, 0);
    const agentId = await agentIdFor(assignment.id);
    await storage.putByKey(
      assignmentWorkingKey(company.slug, taskId, 0, 'out.md'),
      Buffer.from('# out\n'),
      'text/markdown',
    );

    const body = {
      agentId,
      summary: 'done',
      prepared: [{ type: 'assignment-working-path', value: 'out.md' }],
    };
    const [a, b] = await Promise.all([
      request(app.getHttpServer())
        .post(`/internal/assignment/${assignment.id}/complete`)
        .set('X-Internal-Api-Key', INTERNAL_KEY)
        .send(body),
      request(app.getHttpServer())
        .post(`/internal/assignment/${assignment.id}/complete`)
        .set('X-Internal-Api-Key', INTERNAL_KEY)
        .send(body),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect((await step(taskId, 0)).status).toBe('in-qa');
  });
});
