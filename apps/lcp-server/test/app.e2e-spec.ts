import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { LcpCompany } from '@lcp/shared';

describe('CompanyController (e2e)', () => {
  let app: INestApplication<App>;
  let repo: Repository<LcpCompany>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    repo = moduleFixture.get(getRepositoryToken(LcpCompany));
  });

  afterEach(async () => {
    await repo.clear();
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

      const record = await repo.findOneBy({ slug: 'acme' });
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

      expect(await repo.count({ where: { slug: 'acme' } })).toBe(1);
      expect((await repo.findOneBy({ slug: 'acme' }))!.name).toBe('Second');
    });
  });

  describe('GET /api/company/:id', () => {
    it('returns 200 with the company when found by UUID', async () => {
      await request(app.getHttpServer())
        .post('/api/company')
        .send({ slug: 'acme', name: 'Acme Corp' });

      const id = (await repo.findOneBy({ slug: 'acme' }))!.id;

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
      // This documents current behaviour; add a NotFoundException guard to return 404 instead.
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

      const id = (await repo.findOneBy({ slug: 'acme' }))!.id;

      await request(app.getHttpServer())
        .put(`/api/company/${id}`)
        .send({ slug: 'acme', name: 'Updated' })
        .expect(200);

      expect((await repo.findOneBy({ id }))!.name).toBe('Updated');
    });
  });
});
