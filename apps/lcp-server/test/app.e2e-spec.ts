import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AuditEvent, LcpAgent, LcpCompany, LcpRole } from '@lcp/shared';
import { AppModule } from '../src/app.module';

describe('CompanyController (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<LcpCompany>;
  let roleRepo: Repository<LcpRole>;
  let agentRepo: Repository<LcpAgent>;
  let auditRepo: Repository<AuditEvent>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    companyRepo = moduleFixture.get(getRepositoryToken(LcpCompany));
    roleRepo = moduleFixture.get(getRepositoryToken(LcpRole));
    agentRepo = moduleFixture.get(getRepositoryToken(LcpAgent));
    auditRepo = moduleFixture.get(getRepositoryToken(AuditEvent));
  });

  afterEach(async () => {
    // Clear in FK-safe order: dependents before their referenced tables
    await auditRepo.clear();
    await agentRepo.clear();
    await roleRepo.clear();
    await companyRepo.clear();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /api/company', () => {
    it('returns 201 when creating a company', async () => {
      await request(app.getHttpServer())
        .post('/api/company')
        .send({ slug: 'acme', name: 'Acme Corp' })
        .expect(201);
    });

    it('persists the company so it can be retrieved', async () => {
      await request(app.getHttpServer())
        .post('/api/company')
        .send({ slug: 'acme', name: 'Acme Corp' });

      const record = await companyRepo.findOneBy({ slug: 'acme' });
      expect(record).not.toBeNull();
      expect(record!.name).toBe('Acme Corp');
    });

    it('replaces an existing company with the same slug on a second POST', async () => {
      await request(app.getHttpServer())
        .post('/api/company')
        .send({ slug: 'acme', name: 'First' });

      await request(app.getHttpServer())
        .post('/api/company')
        .send({ slug: 'acme', name: 'Second' });

      expect(await companyRepo.count({ where: { slug: 'acme' } })).toBe(1);
      expect((await companyRepo.findOneBy({ slug: 'acme' }))!.name).toBe(
        'Second',
      );
    });
  });

  describe('GET /api/company/:id', () => {
    it('returns 200 with the company when found by UUID', async () => {
      await request(app.getHttpServer())
        .post('/api/company')
        .send({ slug: 'acme', name: 'Acme Corp' });

      const id = (await companyRepo.findOneBy({ slug: 'acme' }))!.id;

      const res = await request(app.getHttpServer())
        .get(`/api/company/${id}`)
        .expect(200);

      const body = res.body as { slug: string; name: string };
      expect(body.slug).toBe('acme');
      expect(body.name).toBe('Acme Corp');
    });

    it('returns 200 with the company when found by slug', async () => {
      await request(app.getHttpServer())
        .post('/api/company')
        .send({ slug: 'acme', name: 'Acme Corp' });

      const res = await request(app.getHttpServer())
        .get('/api/company/acme')
        .expect(200);

      expect((res.body as { slug: string }).slug).toBe('acme');
    });

    it('returns 200 with empty body for an unknown UUID', async () => {
      // NestJS serialises a null return as {} rather than null.
      // TODO: add a NotFoundException guard to return 404 instead — before guarded endpoints are shipped, to align with REST conventions.
      const res = await request(app.getHttpServer())
        .get('/api/company/00000000-0000-0000-0000-000000000000')
        .expect(200);

      expect(res.body).toEqual({});
    });
  });

  describe('PUT /api/company/:id', () => {
    it('updates the company name', async () => {
      await request(app.getHttpServer())
        .post('/api/company')
        .send({ slug: 'acme', name: 'Original' });

      const id = (await companyRepo.findOneBy({ slug: 'acme' }))!.id;

      await request(app.getHttpServer())
        .put(`/api/company/${id}`)
        .send({ slug: 'acme', name: 'Updated' })
        .expect(200);

      expect((await companyRepo.findOneBy({ id }))!.name).toBe('Updated');
    });
  });
});
