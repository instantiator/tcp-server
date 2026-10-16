import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../../../apps/tcp-server/src/app.module';
import { makeTestJwt } from '../helpers/test-jwt';

describe('LlmDefaultsController (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    // Listening, not just init() — see agent.e2e-spec.ts for why.
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/system/llm-defaults returns 401 without a token', () =>
    request(app.getHttpServer()).get('/api/system/llm-defaults').expect(401));

  describe('with a token', () => {
    let body: Record<string, unknown>;

    beforeAll(async () => {
      const res = await request(app.getHttpServer())
        .get('/api/system/llm-defaults')
        .set('Authorization', `Bearer ${makeTestJwt()}`)
        .expect(200);
      body = res.body as Record<string, unknown>;
    });

    it('reports no app models when .env.testing sets none', () => {
      expect(body.chat).toBeNull();
      expect(body.embedding).toBeNull();
    });

    it('reports the vector width as a number', () => {
      expect(typeof body.embeddingDimension).toBe('number');
    });

    it('never leaks a key or an address', () => {
      const text = JSON.stringify(body);
      expect(text).not.toContain('apiKey');
      expect(text).not.toContain('baseUrl');
    });
  });
});
