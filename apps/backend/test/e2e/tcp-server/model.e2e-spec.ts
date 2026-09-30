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
    // Listening, not just init() — see agent.e2e-spec.ts for why.
    await app.listen(0);
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

    // No network: an unknown provider fails in buildChatModel, before any
    // request. A real endpoint here would make the test depend on what's
    // running on the machine (and a refused connection is retried for longer
    // than the test timeout).
    it('returns 201 with a per-model result, reporting a failure as incompatible', () =>
      request(app.getHttpServer())
        .post('/api/model/check')
        .set('Authorization', `Bearer ${jwt}`)
        .send({
          models: [
            { provider: 'no-such-provider', model: 'any', apiKey: 'stub-key' },
          ],
        })
        .expect(201)
        .expect(({ body }) => {
          expect(body).toEqual([
            expect.objectContaining({
              provider: 'no-such-provider',
              compatible: false,
              error: 'Unsupported LLM provider: no-such-provider',
            }),
          ]);
        }));
  });
});
