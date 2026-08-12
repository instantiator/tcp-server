import {
  CompanyUser,
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
import { makeTestJwt } from '../helpers/test-jwt';
import { seedMembership } from '../helpers/seed-membership';

describe('AssignmentController (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<TcpCompany>;
  let roleRepo: Repository<TcpRole>;
  let taskRepo: Repository<TcpTask>;
  let assignmentRepo: Repository<TcpAssignment>;
  let jwt: string;
  let companyId: UUID;
  let roleId: UUID;

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
    jwt = makeTestJwt();

    const company = await companyRepo.save(
      companyRepo.create({
        slug: `assignment-co-${Date.now()}`,
        name: 'Assignment Co',
        description: 'test',
      }),
    );
    companyId = company.id;
    await seedMembership(
      module.get(getRepositoryToken(CompanyUser)),
      company.id,
    );
    const role = await roleRepo.save(
      roleRepo.create({
        slug: 'worker',
        name: 'Worker',
        description: 'Test role',
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
    await assignmentRepo.createQueryBuilder().delete().execute();
    await taskRepo.createQueryBuilder().delete().execute();
  });

  afterAll(async () => {
    await roleRepo.createQueryBuilder().delete().execute();
    await companyRepo.createQueryBuilder().delete().execute();
    await app.close();
  });

  describe('GET /api/assignment', () => {
    it('returns 400 without companyId or taskId', () =>
      request(app.getHttpServer())
        .get('/api/assignment')
        .set('Authorization', `Bearer ${jwt}`)
        .expect(400));

    it('returns 401 without a bearer token', () =>
      request(app.getHttpServer())
        .get(`/api/assignment?companyId=${companyId}`)
        .expect(401));

    it('lists assignments for a company', async () => {
      const task = await taskRepo.save(
        taskRepo.create({ companyId, request: 'Do a thing', shortcode: '000' }),
      );
      const orphan = await assignmentRepo.save(
        assignmentRepo.create({
          companyId,
          taskId: null,
          mode: 'chat',
          prompt: 'chat',
          roleId,
        }),
      );
      const owned = await assignmentRepo.save(
        assignmentRepo.create({
          companyId,
          taskId: task.id,
          mode: 'implement',
          prompt: 'do it',
          roleId,
        }),
      );

      const res = await request(app.getHttpServer())
        .get(`/api/assignment?companyId=${companyId}`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      const ids = (res.body as TcpAssignment[]).map((a) => a.id);
      expect(ids).toEqual(expect.arrayContaining([orphan.id, owned.id]));
    });

    it('filters to orphan assignments with taskId=null', async () => {
      const task = await taskRepo.save(
        taskRepo.create({ companyId, request: 'Do a thing', shortcode: '000' }),
      );
      const orphan = await assignmentRepo.save(
        assignmentRepo.create({
          companyId,
          taskId: null,
          mode: 'chat',
          prompt: 'chat',
          roleId,
        }),
      );
      await assignmentRepo.save(
        assignmentRepo.create({
          companyId,
          taskId: task.id,
          mode: 'implement',
          prompt: 'do it',
          roleId,
        }),
      );

      const res = await request(app.getHttpServer())
        .get(`/api/assignment?companyId=${companyId}&taskId=null`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      const ids = (res.body as TcpAssignment[]).map((a) => a.id);
      expect(ids).toEqual([orphan.id]);
    });

    it('filters by taskId', async () => {
      const task = await taskRepo.save(
        taskRepo.create({ companyId, request: 'Do a thing', shortcode: '000' }),
      );
      const owned = await assignmentRepo.save(
        assignmentRepo.create({
          companyId,
          taskId: task.id,
          mode: 'implement',
          prompt: 'do it',
          roleId,
        }),
      );
      await assignmentRepo.save(
        assignmentRepo.create({
          companyId,
          taskId: null,
          mode: 'chat',
          prompt: 'chat',
          roleId,
        }),
      );

      const res = await request(app.getHttpServer())
        .get(`/api/assignment?taskId=${task.id}`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      const ids = (res.body as TcpAssignment[]).map((a) => a.id);
      expect(ids).toEqual([owned.id]);
    });

    it('filters by status', async () => {
      const succeeded = await assignmentRepo.save(
        assignmentRepo.create({
          companyId,
          taskId: null,
          mode: 'chat',
          prompt: 'chat',
          roleId,
          status: 'succeeded',
        }),
      );
      await assignmentRepo.save(
        assignmentRepo.create({
          companyId,
          taskId: null,
          mode: 'chat',
          prompt: 'chat',
          roleId,
          status: 'ready',
        }),
      );

      const res = await request(app.getHttpServer())
        .get(`/api/assignment?companyId=${companyId}&status=succeeded`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      const ids = (res.body as TcpAssignment[]).map((a) => a.id);
      expect(ids).toEqual([succeeded.id]);
    });
  });

  describe('GET /api/assignment/:id', () => {
    it('returns the assignment by id', async () => {
      const assignment = await assignmentRepo.save(
        assignmentRepo.create({
          companyId,
          taskId: null,
          mode: 'chat',
          prompt: 'chat',
          roleId,
        }),
      );

      const res = await request(app.getHttpServer())
        .get(`/api/assignment/${assignment.id}`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      expect((res.body as TcpAssignment).id).toBe(assignment.id);
    });

    it('returns 404 for an unknown assignment', () =>
      request(app.getHttpServer())
        .get('/api/assignment/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${jwt}`)
        .expect(404));
  });
});
