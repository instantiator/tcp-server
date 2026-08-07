// tcp-agent uses makeTypeOrmConfig so SQLite fallback works, but Redis is required for a 200
// response from /health. When Redis is unavailable, the endpoint returns 503 — both are valid.
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../../../apps/tcp-agent/src/app.module';

describe('tcp-agent health (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());

  it('GET /health responds with a health check result (200 when infra up, 503 when not)', () =>
    request(app.getHttpServer())
      .get('/health')
      .expect((res) => {
        expect([200, 503]).toContain(res.status);
        expect((res.body as { status: string }).status).toMatch(/ok|error/);
      }));
});
