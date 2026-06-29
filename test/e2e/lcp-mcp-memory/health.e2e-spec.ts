// lcp-mcp-memory requires a real Postgres connection — skip if DATABASE_URL is absent or sqlite.
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../../../apps/lcp-mcp-memory/src/app.module';

const hasPg = process.env.DATABASE_URL?.startsWith('postgres');

(hasPg ? describe : describe.skip)('lcp-mcp-memory health (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());

  it('GET /health responds with a health check result', () =>
    request(app.getHttpServer())
      .get('/health')
      .expect((res) => {
        expect([200, 503]).toContain(res.status);
        expect((res.body as { status: string }).status).toMatch(/ok|error/);
      }));
});
