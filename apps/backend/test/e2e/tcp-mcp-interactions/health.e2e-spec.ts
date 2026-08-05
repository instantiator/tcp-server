import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../../../apps/tcp-mcp-interactions/src/app.module';

describe('tcp-mcp-interactions health (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());

  it('GET /health returns 200 with static ok status', () =>
    request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect(({ body }) => {
        expect((body as { status: string }).status).toBe('ok');
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
        expect(body.details?.service?.name).toBe('tcp-mcp-interactions');
        expect(body.info?.service?.name).toBe('tcp-mcp-interactions');
      }));
});
