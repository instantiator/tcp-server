import {
  AuditEvent,
  LcpAgent,
  LcpAssignment,
  LcpCompany,
  LcpRole,
  LcpTask,
} from '@lcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import type { UUID } from 'crypto';
import { Repository } from 'typeorm';
import { AppModule } from '../../../apps/lcp-server/src/app.module';
import { makeTestJwt } from '../helpers/test-jwt';

describe('TaskController (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<LcpCompany>;
  let roleRepo: Repository<LcpRole>;
  let taskRepo: Repository<LcpTask>;
  let assignmentRepo: Repository<LcpAssignment>;
  let agentRepo: Repository<LcpAgent>;
  let auditRepo: Repository<AuditEvent>;
  let jwt: string;

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
    agentRepo = moduleFixture.get(getRepositoryToken(LcpAgent));
    auditRepo = moduleFixture.get(getRepositoryToken(AuditEvent));
    jwt = makeTestJwt();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('with a company', () => {
    let company: LcpCompany;

    beforeAll(async () => {
      company = await companyRepo.save(
        companyRepo.create({
          slug: `task-co-${Date.now()}`,
          name: 'Task Co',
          description: 'test',
        }),
      );
    });

    afterEach(async () => {
      await auditRepo.createQueryBuilder().delete().execute();
      await agentRepo.createQueryBuilder().delete().execute();
      await assignmentRepo.createQueryBuilder().delete().execute();
      await taskRepo.createQueryBuilder().delete().execute();
    });

    afterAll(async () => {
      await companyRepo.delete(company.id);
    });

    describe('POST /api/task', () => {
      it('returns 201 and creates a task in the ready state', async () => {
        const res = await request(app.getHttpServer())
          .post('/api/task')
          .set('Authorization', `Bearer ${jwt}`)
          .send({ companyId: company.id, request: 'Write a report' });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
          companyId: company.id,
          request: 'Write a report',
          status: 'ready',
          materials: [],
          shortcode: '000',
        });
      });

      it('gives each task in a company a unique, incrementing shortcode', async () => {
        const create = async () => {
          const res = await request(app.getHttpServer())
            .post('/api/task')
            .set('Authorization', `Bearer ${jwt}`)
            .send({ companyId: company.id, request: 'Write a report' });
          return (res.body as LcpTask).shortcode;
        };
        const first = await create();
        const second = await create();
        expect(second).not.toBe(first);
        expect(Number(second)).toBe(Number(first) + 1);
      });

      it('returns 400 for a missing request body field', async () => {
        const res = await request(app.getHttpServer())
          .post('/api/task')
          .set('Authorization', `Bearer ${jwt}`)
          .send({ companyId: company.id });
        expect(res.status).toBe(400);
      });

      it('returns 404 for an unknown company', async () => {
        const res = await request(app.getHttpServer())
          .post('/api/task')
          .set('Authorization', `Bearer ${jwt}`)
          .send({
            companyId: '00000000-0000-0000-0000-000000000000',
            request: 'Write a report',
          });
        expect(res.status).toBe(404);
      });

      it('returns 400 for a materials entry with a type outside the allowed @IsIn set', async () => {
        const res = await request(app.getHttpServer())
          .post('/api/task')
          .set('Authorization', `Bearer ${jwt}`)
          .send({
            companyId: company.id,
            request: 'Write a report',
            materials: [{ type: 'not-a-real-type', value: 'x' }],
          });
        expect(res.status).toBe(400);
      });

      it('returns 400 for an expected entry with a type outside the allowed @IsIn set', async () => {
        const res = await request(app.getHttpServer())
          .post('/api/task')
          .set('Authorization', `Bearer ${jwt}`)
          .send({
            companyId: company.id,
            request: 'Write a report',
            expected: [{ type: 'not-a-real-type', value: 'x' }],
          });
        expect(res.status).toBe(400);
      });

      it('returns 401 without a bearer token', async () => {
        const res = await request(app.getHttpServer())
          .post('/api/task')
          .send({ companyId: company.id, request: 'Write a report' });
        expect(res.status).toBe(401);
      });

      describe('with a role', () => {
        let role: LcpRole;

        beforeAll(async () => {
          role = await roleRepo.save(
            roleRepo.create({
              companyId: company.id,
              company,
              slug: 'planner',
              name: 'Planner',
              description: 'Plans tasks',
              knowledgeDomains: [],
              mcpServerList: [],
            }),
          );
        });

        afterAll(async () => {
          await roleRepo.delete(role.id);
        });

        it('returns 404 when plannerRoleId belongs to no role in the company', async () => {
          const res = await request(app.getHttpServer())
            .post('/api/task')
            .set('Authorization', `Bearer ${jwt}`)
            .send({
              companyId: company.id,
              request: 'Write a report',
              plannerRoleId: '00000000-0000-0000-0000-000000000000',
            });
          expect(res.status).toBe(404);
        });

        it('creates a task with an explicit plannerRoleId', async () => {
          const res = await request(app.getHttpServer())
            .post('/api/task')
            .set('Authorization', `Bearer ${jwt}`)
            .send({
              companyId: company.id,
              request: 'Write a report',
              plannerRoleId: role.id,
            });
          expect(res.status).toBe(201);
          expect((res.body as LcpTask).plannerRoleId).toBe(role.id);
        });

        describe('with a task', () => {
          let task: LcpTask;

          beforeEach(async () => {
            const res = await request(app.getHttpServer())
              .post('/api/task')
              .set('Authorization', `Bearer ${jwt}`)
              .send({ companyId: company.id, request: 'Write a report' });
            task = res.body as LcpTask;
          });

          describe('POST /api/task/:id/materials', () => {
            it('returns 201 and appends a task-materials-path artifact', async () => {
              const res = await request(app.getHttpServer())
                .post(`/api/task/${task.id}/materials`)
                .set('Authorization', `Bearer ${jwt}`)
                .attach('file', Buffer.from('hello'), 'brief.txt');
              expect(res.status).toBe(201);
              expect(res.body).toMatchObject({ name: 'brief.txt', size: 5 });

              const updated = await request(app.getHttpServer())
                .get(`/api/task/${task.id}`)
                .set('Authorization', `Bearer ${jwt}`);
              expect(
                (updated.body as { task: LcpTask }).task.materials,
              ).toEqual([{ type: 'task-materials-path', value: 'brief.txt' }]);
            });

            it('returns 404 for an unknown task', async () => {
              const res = await request(app.getHttpServer())
                .post(
                  '/api/task/00000000-0000-0000-0000-000000000000/materials',
                )
                .set('Authorization', `Bearer ${jwt}`)
                .attach('file', Buffer.from('hello'), 'brief.txt');
              expect(res.status).toBe(404);
            });

            it('returns 422 for invalid content and never appends the artifact', async () => {
              const res = await request(app.getHttpServer())
                .post(`/api/task/${task.id}/materials`)
                .set('Authorization', `Bearer ${jwt}`)
                .attach('file', Buffer.from('{not valid json'), 'bad.json');
              expect(res.status).toBe(422);

              const updated = await request(app.getHttpServer())
                .get(`/api/task/${task.id}`)
                .set('Authorization', `Bearer ${jwt}`);
              expect(
                (updated.body as { task: LcpTask }).task.materials,
              ).toEqual([]);
            });

            it('returns 409 once the task has left ready', async () => {
              await companyRepo.update(company.id, { plannerRoleId: role.id });
              await request(app.getHttpServer())
                .post(`/api/task/${task.id}/start`)
                .set('Authorization', `Bearer ${jwt}`)
                .expect(202);

              const res = await request(app.getHttpServer())
                .post(`/api/task/${task.id}/materials`)
                .set('Authorization', `Bearer ${jwt}`)
                .attach('file', Buffer.from('hello'), 'brief.txt');
              expect(res.status).toBe(409);

              await companyRepo.update(company.id, { plannerRoleId: null });
            });
          });

          describe('PUT /api/task/:id', () => {
            it('edits request, plannerRoleId, materials, and expected while ready', async () => {
              const res = await request(app.getHttpServer())
                .put(`/api/task/${task.id}`)
                .set('Authorization', `Bearer ${jwt}`)
                .send({
                  request: 'Write a longer report',
                  plannerRoleId: role.id,
                  materials: [{ type: 'inline-text', value: 'context' }],
                  expected: [{ type: 'inline-text', value: 'a summary' }],
                });
              expect(res.status).toBe(200);
              expect(res.body).toMatchObject({
                request: 'Write a longer report',
                plannerRoleId: role.id,
                materials: [{ type: 'inline-text', value: 'context' }],
                expected: [{ type: 'inline-text', value: 'a summary' }],
                status: 'ready',
              });
            });

            it('changes only the given fields, leaving others unchanged', async () => {
              const res = await request(app.getHttpServer())
                .put(`/api/task/${task.id}`)
                .set('Authorization', `Bearer ${jwt}`)
                .send({ plannerRoleId: role.id });
              expect(res.status).toBe(200);
              expect((res.body as LcpTask).request).toBe(task.request);
              expect((res.body as LcpTask).plannerRoleId).toBe(role.id);
            });

            it('returns 404 for an unknown task', async () => {
              const res = await request(app.getHttpServer())
                .put('/api/task/00000000-0000-0000-0000-000000000000')
                .set('Authorization', `Bearer ${jwt}`)
                .send({ request: 'x' });
              expect(res.status).toBe(404);
            });

            it('returns 404 when plannerRoleId is an unknown role', async () => {
              const res = await request(app.getHttpServer())
                .put(`/api/task/${task.id}`)
                .set('Authorization', `Bearer ${jwt}`)
                .send({
                  plannerRoleId: '00000000-0000-0000-0000-000000000000',
                });
              expect(res.status).toBe(404);
            });

            it('returns 404 when plannerRoleId belongs to a different company', async () => {
              const otherCompany = await companyRepo.save(
                companyRepo.create({
                  slug: `task-co-other-${Date.now()}`,
                  name: 'Other Co',
                  description: 'test',
                }),
              );
              const otherRole = await roleRepo.save(
                roleRepo.create({
                  companyId: otherCompany.id,
                  company: otherCompany,
                  slug: 'other-planner',
                  name: 'Other Planner',
                  description: 'Plans tasks',
                  knowledgeDomains: [],
                  mcpServerList: [],
                }),
              );

              const res = await request(app.getHttpServer())
                .put(`/api/task/${task.id}`)
                .set('Authorization', `Bearer ${jwt}`)
                .send({ plannerRoleId: otherRole.id });
              expect(res.status).toBe(404);

              await roleRepo.delete(otherRole.id);
              await companyRepo.delete(otherCompany.id);
            });

            it('returns 409 once the task has left ready', async () => {
              await companyRepo.update(company.id, { plannerRoleId: role.id });
              await request(app.getHttpServer())
                .post(`/api/task/${task.id}/start`)
                .set('Authorization', `Bearer ${jwt}`)
                .expect(202);

              const res = await request(app.getHttpServer())
                .put(`/api/task/${task.id}`)
                .set('Authorization', `Bearer ${jwt}`)
                .send({ request: 'too late' });
              expect(res.status).toBe(409);

              await companyRepo.update(company.id, { plannerRoleId: null });
            });
          });

          describe('POST /api/task/:id/start', () => {
            it('returns 422 when no planner role is resolvable', async () => {
              const res = await request(app.getHttpServer())
                .post(`/api/task/${task.id}/start`)
                .set('Authorization', `Bearer ${jwt}`);
              expect(res.status).toBe(422);
            });

            it('returns 202, transitions ready -> planning, and dispatches a plan-mode assignment + agent', async () => {
              const created = await request(app.getHttpServer())
                .post('/api/task')
                .set('Authorization', `Bearer ${jwt}`)
                .send({
                  companyId: company.id,
                  request: 'Write a report',
                  plannerRoleId: role.id,
                });
              const startable = created.body as LcpTask;

              const res = await request(app.getHttpServer())
                .post(`/api/task/${startable.id}/start`)
                .set('Authorization', `Bearer ${jwt}`);
              expect(res.status).toBe(202);
              expect((res.body as LcpTask).status).toBe('planning');

              const planAssignment = await assignmentRepo.findOneBy({
                taskId: startable.id,
                mode: 'plan',
              });
              if (!planAssignment)
                throw new Error('plan assignment was not created');
              expect(planAssignment.status).toBe('in-progress');
              expect(planAssignment.roleId).toBe(role.id);
              expect(planAssignment.prompt).toBe('Write a report');
              expect(planAssignment.agentId).not.toBeNull();

              const plannerAgent = await agentRepo.findOneBy({
                id: planAssignment.agentId as UUID,
              });
              expect(plannerAgent).not.toBeNull();
              expect(plannerAgent?.roleId).toBe(role.id);
              expect(plannerAgent?.assignmentId).toBe(planAssignment.id);
            });

            it('returns 202 and falls back to the company default planner role', async () => {
              await companyRepo.update(company.id, { plannerRoleId: role.id });
              const res = await request(app.getHttpServer())
                .post(`/api/task/${task.id}/start`)
                .set('Authorization', `Bearer ${jwt}`);
              expect(res.status).toBe(202);
              expect((res.body as LcpTask).status).toBe('planning');
              await companyRepo.update(company.id, { plannerRoleId: null });
            });

            it('returns 409 on a double start', async () => {
              await companyRepo.update(company.id, { plannerRoleId: role.id });
              await request(app.getHttpServer())
                .post(`/api/task/${task.id}/start`)
                .set('Authorization', `Bearer ${jwt}`)
                .expect(202);

              const res = await request(app.getHttpServer())
                .post(`/api/task/${task.id}/start`)
                .set('Authorization', `Bearer ${jwt}`);
              expect(res.status).toBe(409);
              await companyRepo.update(company.id, { plannerRoleId: null });
            });

            it('returns 404 for an unknown task', async () => {
              const res = await request(app.getHttpServer())
                .post('/api/task/00000000-0000-0000-0000-000000000000/start')
                .set('Authorization', `Bearer ${jwt}`);
              expect(res.status).toBe(404);
            });
          });

          describe('POST /api/task/:id/cancel', () => {
            it('returns 202 and transitions ready -> cancelled', async () => {
              const res = await request(app.getHttpServer())
                .post(`/api/task/${task.id}/cancel`)
                .set('Authorization', `Bearer ${jwt}`);
              expect(res.status).toBe(202);
              expect((res.body as LcpTask).status).toBe('cancelled');
            });

            it("cascades to the task's non-terminal assignments", async () => {
              const inProgress = await assignmentRepo.save(
                assignmentRepo.create({
                  companyId: company.id,
                  company,
                  taskId: task.id,
                  task,
                  mode: 'implement',
                  orderIndex: 0,
                  prompt: 'Step 0',
                  roleId: role.id,
                  role,
                  status: 'in-progress',
                }),
              );
              const alreadySucceeded = await assignmentRepo.save(
                assignmentRepo.create({
                  companyId: company.id,
                  company,
                  taskId: task.id,
                  task,
                  mode: 'implement',
                  orderIndex: 1,
                  prompt: 'Step 1',
                  roleId: role.id,
                  role,
                  status: 'succeeded',
                }),
              );

              const res = await request(app.getHttpServer())
                .post(`/api/task/${task.id}/cancel`)
                .set('Authorization', `Bearer ${jwt}`);
              expect(res.status).toBe(202);

              const reloadedInProgress = await assignmentRepo.findOneBy({
                id: inProgress.id,
              });
              const reloadedSucceeded = await assignmentRepo.findOneBy({
                id: alreadySucceeded.id,
              });
              expect(reloadedInProgress?.status).toBe('cancelled');
              expect(reloadedSucceeded?.status).toBe('succeeded');
            });

            it('returns 404 for an unknown task', async () => {
              const res = await request(app.getHttpServer())
                .post('/api/task/00000000-0000-0000-0000-000000000000/cancel')
                .set('Authorization', `Bearer ${jwt}`);
              expect(res.status).toBe(404);
            });

            it('returns 409 when the task is already terminal (double cancel)', async () => {
              await request(app.getHttpServer())
                .post(`/api/task/${task.id}/cancel`)
                .set('Authorization', `Bearer ${jwt}`)
                .expect(202);

              const res = await request(app.getHttpServer())
                .post(`/api/task/${task.id}/cancel`)
                .set('Authorization', `Bearer ${jwt}`);
              expect(res.status).toBe(409);
            });
          });

          describe('GET /api/task/:id', () => {
            it('returns the task with its assignments, plan first ordered by orderIndex then the rest by createdAt', async () => {
              const orphanLike = await assignmentRepo.save(
                assignmentRepo.create({
                  companyId: company.id,
                  company,
                  taskId: task.id,
                  task,
                  mode: 'plan',
                  prompt: 'Plan it',
                  roleId: role.id,
                  role,
                }),
              );
              const step1 = await assignmentRepo.save(
                assignmentRepo.create({
                  companyId: company.id,
                  company,
                  taskId: task.id,
                  task,
                  mode: 'implement',
                  orderIndex: 1,
                  prompt: 'Step 1',
                  roleId: role.id,
                  role,
                }),
              );
              const step0 = await assignmentRepo.save(
                assignmentRepo.create({
                  companyId: company.id,
                  company,
                  taskId: task.id,
                  task,
                  mode: 'implement',
                  orderIndex: 0,
                  prompt: 'Step 0',
                  roleId: role.id,
                  role,
                }),
              );

              const res = await request(app.getHttpServer())
                .get(`/api/task/${task.id}`)
                .set('Authorization', `Bearer ${jwt}`);
              expect(res.status).toBe(200);
              const body = res.body as {
                task: LcpTask;
                assignments: LcpAssignment[];
              };
              expect(body.task.id).toBe(task.id);
              expect(body.assignments.map((a) => a.id)).toEqual([
                step0.id,
                step1.id,
                orphanLike.id,
              ]);
            });

            it('returns 404 for an unknown task', async () => {
              const res = await request(app.getHttpServer())
                .get('/api/task/00000000-0000-0000-0000-000000000000')
                .set('Authorization', `Bearer ${jwt}`);
              expect(res.status).toBe(404);
            });
          });

          describe('GET /api/task/:id/history', () => {
            it("returns every row denormalised to the task's id — agent rows and agent-less orchestrator rows — oldest first", async () => {
              const assignment = await assignmentRepo.save(
                assignmentRepo.create({
                  companyId: company.id,
                  company,
                  taskId: task.id,
                  task,
                  mode: 'plan',
                  prompt: 'Plan it',
                  roleId: role.id,
                  role,
                }),
              );
              const agent = await agentRepo.save(
                agentRepo.create({
                  companyId: company.id,
                  roleId: role.id,
                  assignmentId: assignment.id,
                  initialPrompt: 'Plan it',
                }),
              );
              await assignmentRepo.update(assignment.id, {
                agentId: agent.id,
              });
              // An unrelated agent (not part of this task) whose events must not leak in.
              const otherAssignment = await assignmentRepo.save(
                assignmentRepo.create({
                  companyId: company.id,
                  company,
                  taskId: null,
                  mode: 'chat',
                  prompt: 'chat',
                  roleId: role.id,
                  role,
                }),
              );
              const otherAgent = await agentRepo.save(
                agentRepo.create({
                  companyId: company.id,
                  roleId: role.id,
                  assignmentId: otherAssignment.id,
                  initialPrompt: 'chat',
                }),
              );

              // An orchestrator row (no agent) denormalised to the task — the
              // assignments→agents join used to miss these; the taskId column
              // now includes them.
              await auditRepo.save(
                auditRepo.create({
                  companyId: company.id,
                  role: 'orchestrator',
                  agentId: null,
                  taskId: task.id,
                  eventType: 'state_change',
                  payload: { entity: 'task', newStatus: 'planning' },
                }),
              );
              await auditRepo.save(
                auditRepo.create({
                  companyId: company.id,
                  role: 'Planner',
                  agentId: agent.id,
                  taskId: task.id,
                  eventType: 'state_change',
                  payload: { newStatus: 'running' },
                }),
              );
              await auditRepo.save(
                auditRepo.create({
                  companyId: company.id,
                  role: 'Planner',
                  agentId: agent.id,
                  taskId: task.id,
                  eventType: 'agent_loop_completion',
                  payload: { summary: 'planned' },
                }),
              );
              await auditRepo.save(
                auditRepo.create({
                  companyId: company.id,
                  role: 'Other',
                  agentId: otherAgent.id,
                  taskId: null,
                  eventType: 'state_change',
                  payload: { newStatus: 'running' },
                }),
              );

              const res = await request(app.getHttpServer())
                .get(`/api/task/${task.id}/history`)
                .set('Authorization', `Bearer ${jwt}`);
              expect(res.status).toBe(200);
              const rows = res.body as { eventType: string; agentId: string }[];
              expect(rows).toHaveLength(3);
              expect(rows[0].eventType).toBe('state_change');
              expect(rows[0].agentId).toBeNull();
              expect(rows[1].eventType).toBe('state_change');
              expect(rows[1].agentId).toBe(agent.id);
              expect(rows[2].eventType).toBe('agent_loop_completion');
            });

            it('returns 404 for an unknown task', async () => {
              const res = await request(app.getHttpServer())
                .get('/api/task/00000000-0000-0000-0000-000000000000/history')
                .set('Authorization', `Bearer ${jwt}`);
              expect(res.status).toBe(404);
            });
          });
        });
      });
    });

    describe('GET /api/task', () => {
      it('returns 400 without companyId', async () => {
        const res = await request(app.getHttpServer())
          .get('/api/task')
          .set('Authorization', `Bearer ${jwt}`);
        expect(res.status).toBe(400);
      });

      it('returns 404 for an unknown company', async () => {
        const res = await request(app.getHttpServer())
          .get('/api/task?companyId=00000000-0000-0000-0000-000000000000')
          .set('Authorization', `Bearer ${jwt}`);
        expect(res.status).toBe(404);
      });

      it('lists tasks for the company', async () => {
        await request(app.getHttpServer())
          .post('/api/task')
          .set('Authorization', `Bearer ${jwt}`)
          .send({ companyId: company.id, request: 'Write a report' });

        const res = await request(app.getHttpServer())
          .get(`/api/task?companyId=${company.id}`)
          .set('Authorization', `Bearer ${jwt}`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect((res.body as LcpTask[]).length).toBeGreaterThan(0);
      });
    });
  });
});
