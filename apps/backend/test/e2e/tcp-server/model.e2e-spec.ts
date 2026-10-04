import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../../../apps/tcp-server/src/app.module';
import { makeTestJwt } from '../helpers/test-jwt';

describe('ModelController (e2e)', () => {
  let app: INestApplication<App>;
  /** Named in `.env.testing`'s TCP_ADMIN_IDENTIFIERS. */
  let adminJwt: string;
  let userJwt: string;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    // Listening, not just init() — see agent.e2e-spec.ts for why.
    await app.listen(0);
    adminJwt = makeTestJwt({ sub: 'e2e-admin' });
    userJwt = makeTestJwt();
  });

  afterAll(() => app.close());

  describe('POST /api/model/check', () => {
    it('returns 401 without a token', () =>
      request(app.getHttpServer())
        .post('/api/model/check')
        .send({ models: [] })
        .expect(401));

    // The route connects wherever the body says, so it is a network probe:
    // administrators only.
    it('returns 403 for a signed-in user who is not an administrator', () =>
      request(app.getHttpServer())
        .post('/api/model/check')
        .set('Authorization', `Bearer ${userJwt}`)
        .send({ models: [] })
        .expect(403));

    it('returns 201 when given an empty models array', () =>
      request(app.getHttpServer())
        .post('/api/model/check')
        .set('Authorization', `Bearer ${adminJwt}`)
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
        .set('Authorization', `Bearer ${adminJwt}`)
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
              errorCode: 'unsupported_provider',
            }),
          ]);
        }));

    // Refused before any request, so no network is involved here either.
    it('refuses a destination outside the allowed hosts, per model', () =>
      request(app.getHttpServer())
        .post('/api/model/check')
        .set('Authorization', `Bearer ${adminJwt}`)
        .send({
          models: [
            {
              provider: 'openai-compatible',
              model: 'any',
              baseUrl: 'http://169.254.169.254/v1',
            },
          ],
        })
        .expect(201)
        .expect(({ body }) => {
          expect(body).toEqual([
            expect.objectContaining({
              compatible: false,
              errorCode: 'destination_refused',
            }),
          ]);
        }));
  });
});
