import { AuditEvent, TcpAgent, TcpCompany, TcpRole } from '@tcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../../apps/tcp-server/src/app.module';
import { makeTestJwt } from '../helpers/test-jwt';

describe('CompanyUserController (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<TcpCompany>;
  let roleRepo: Repository<TcpRole>;
  let agentRepo: Repository<TcpAgent>;
  let auditRepo: Repository<AuditEvent>;
  let jwt: string;
  let companyId: string;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    companyRepo = module.get(getRepositoryToken(TcpCompany));
    roleRepo = module.get(getRepositoryToken(TcpRole));
    agentRepo = module.get(getRepositoryToken(TcpAgent));
    auditRepo = module.get(getRepositoryToken(AuditEvent));
    jwt = makeTestJwt();

    const company = await companyRepo.save(
      companyRepo.create({
        slug: 'user-co',
        name: 'UserCo',
        description: 'Test',
      }),
    );
    companyId = company.id;
  });

  afterEach(async () => {
    await auditRepo.createQueryBuilder().delete().execute();
    await agentRepo.createQueryBuilder().delete().execute();
  });

  afterAll(async () => {
    await roleRepo.createQueryBuilder().delete().execute();
    await companyRepo.createQueryBuilder().delete().execute();
    await app.close();
  });

  describe('GET /api/company/:companyId/users', () => {
    it('returns 401 without a token', () =>
      request(app.getHttpServer())
        .get(`/api/company/${companyId}/users`)
        .expect(401));

    it('returns 200 with an empty list initially', () =>
      request(app.getHttpServer())
        .get(`/api/company/${companyId}/users`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200)
        .expect(({ body }) => {
          expect(Array.isArray(body)).toBe(true);
        }));
  });

  describe('POST /api/company/:companyId/users', () => {
    it('returns 201 and creates a user', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/company/${companyId}/users`)
        .set('Authorization', `Bearer ${jwt}`)
        .send({
          identifier: 'alice@example.com',
          memberType: 'member',
          name: 'Alice',
        })
        .expect(201);
      expect((res.body as { id: string }).id).toBeDefined();
    });
  });

  describe('PATCH /api/company/:companyId/users/:userId', () => {
    it('returns 200 and updates the user', async () => {
      const bob = (
        await request(app.getHttpServer())
          .post(`/api/company/${companyId}/users`)
          .set('Authorization', `Bearer ${jwt}`)
          .send({
            identifier: 'bob@example.com',
            memberType: 'member',
            name: 'Bob',
          })
          .expect(201)
      ).body as { id: string };

      await request(app.getHttpServer())
        .patch(`/api/company/${companyId}/users/${bob.id}`)
        .set('Authorization', `Bearer ${jwt}`)
        .send({ name: 'Robert' })
        .expect(200);
    });
  });

  describe('DELETE /api/company/:companyId/users/:userId', () => {
    it('returns 204 and removes the user', async () => {
      const carol = (
        await request(app.getHttpServer())
          .post(`/api/company/${companyId}/users`)
          .set('Authorization', `Bearer ${jwt}`)
          .send({
            identifier: 'carol@example.com',
            memberType: 'member',
            name: 'Carol',
          })
          .expect(201)
      ).body as { id: string };

      await request(app.getHttpServer())
        .delete(`/api/company/${companyId}/users/${carol.id}`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(204);
    });
  });
});
