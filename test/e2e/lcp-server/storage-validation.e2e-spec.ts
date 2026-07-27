import { TcpCompany } from '@lcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../../apps/lcp-server/src/app.module';
import { makeTestJwt } from '../helpers/test-jwt';

/** e2e coverage for the standalone `POST /api/storage/validate` path (docs/prompts/009.4). */
describe('StorageValidationController (e2e)', () => {
  let app: INestApplication<App>;
  let companyRepo: Repository<TcpCompany>;
  let jwt: string;
  let company: TcpCompany;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    companyRepo = moduleFixture.get(getRepositoryToken(TcpCompany));
    jwt = makeTestJwt();

    company = await companyRepo.save(
      companyRepo.create({
        slug: 'validate-endpoint-co',
        name: 'Validate Endpoint Co',
        description: 'test',
      }),
    );
  });

  afterAll(async () => {
    await companyRepo.createQueryBuilder().delete().execute();
    await app.close();
  });

  it('returns 404 for a specifically-named file that does not exist', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/storage/validate')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ path: `${company.slug}/tasks/x/missing.json` });
    expect(res.status).toBe(404);
  });

  it('returns 200 with an empty validations array when a glob matches nothing', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/storage/validate')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ path: `${company.slug}/tasks/x/*.json` });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      query: { path: `${company.slug}/tasks/x/*.json`, recursive: false },
      validations: [],
    });
  });

  it('returns 200 with valid:true for a document that satisfies its format rules', async () => {
    const path = `${company.slug}/tasks/x/config.json`;
    await request(app.getHttpServer())
      .post(`/api/storage?path=${encodeURIComponent(path)}`)
      .set('Authorization', `Bearer ${jwt}`)
      .attach('file', Buffer.from('{"a":1}'), 'config.json');

    const res = await request(app.getHttpServer())
      .post('/api/storage/validate')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ path });
    expect(res.status).toBe(200);
    const body = res.body as {
      validations: {
        path: string;
        found: boolean;
        size: number;
        valid: boolean;
        errors: string[];
      }[];
    };
    expect(body.validations).toEqual([
      { path, found: true, size: 7, valid: true, errors: [] },
    ]);
  });

  it('returns 401 without a bearer token', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/storage/validate')
      .send({ path: 'acme/a.json' });
    expect(res.status).toBe(401);
  });
});
