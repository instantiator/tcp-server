import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../../../apps/tcp-server/src/app.module';
import { makeTestJwt } from '../helpers/test-jwt';

describe('ModelController (e2e)', () => {
  let app: INestApplication<App>;
  let jwt: string;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    jwt = makeTestJwt();
  });

  afterAll(() => app.close());

  describe('POST /api/model/check', () => {
    it('returns 401 without a token', () =>
      request(app.getHttpServer())
        .post('/api/model/check')
        .send({ models: [] })
        .expect(401));

    it('returns 200 when given an empty models array', () =>
      request(app.getHttpServer())
        .post('/api/model/check')
        .set('Authorization', `Bearer ${jwt}`)
        .send({ models: [] })
        .expect(201)
        .expect(({ body }) => {
          expect(Array.isArray(body)).toBe(true);
        }));

    it('returns 201 for a model list (reachability result reflects whether LM Studio is up)', () =>
      request(app.getHttpServer())
        .post('/api/model/check')
        .set('Authorization', `Bearer ${jwt}`)
        .send({
          models: [
            {
              provider: 'openai',
              model: 'gpt-4o',
              apiKey: 'stub-key',
              baseUrl: 'http://localhost:1234/v1',
            },
          ],
        })
        .expect(201)
        .expect(({ body }) => {
          expect(Array.isArray(body)).toBe(true);
        }));
  });
});
