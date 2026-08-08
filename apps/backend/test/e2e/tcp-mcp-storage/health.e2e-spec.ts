import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../../../apps/tcp-mcp-storage/src/app.module';

describe('tcp-mcp-storage health (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    // Listening, not just init() — see agent.e2e-spec.ts for why.
    await app.listen(0);
  });

  afterAll(() => app.close());

  it('GET /health responds with a health check result (200 or 503)', () =>
    request(app.getHttpServer())
      .get('/health')
      .expect((res) => {
        expect([200, 503]).toContain(res.status);
        expect((res.body as { status: string }).status).toMatch(/ok|error/);
      }));

  // The identity indicator is in the document whether the check passed or
  // failed — a 503 is exactly when knowing which service answered matters.
  it('names the service it answered as, in both info and details', () =>
    request(app.getHttpServer())
      .get('/health')
      .expect((res) => {
        const body = res.body as {
          info?: Record<string, { name?: string }>;
          details?: Record<string, { name?: string }>;
        };
        expect(body.details?.service?.name).toBe('tcp-mcp-storage');
        expect(body.info?.service?.name).toBe('tcp-mcp-storage');
      }));
});
