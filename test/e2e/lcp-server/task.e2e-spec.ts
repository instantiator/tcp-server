import { LcpAssignment, LcpCompany, LcpRole, LcpTask } from '@lcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../../apps/lcp-server/src/app.module';
import { makeTestJwt } from '../helpers/test-jwt';

describe('TaskController (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<LcpCompany>;
  let roleRepo: Repository<LcpRole>;
  let taskRepo: Repository<LcpTask>;
  let assignmentRepo: Repository<LcpAssignment>;
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
        });
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

          describe('POST /api/task/:id/start', () => {
            it('returns 422 when no planner role is resolvable', async () => {
              const res = await request(app.getHttpServer())
                .post(`/api/task/${task.id}/start`)
                .set('Authorization', `Bearer ${jwt}`);
              expect(res.status).toBe(422);
            });

            it('returns 202 and transitions ready -> planning using the task plannerRoleId', async () => {
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
