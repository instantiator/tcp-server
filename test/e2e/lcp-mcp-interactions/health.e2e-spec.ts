import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../../../apps/lcp-mcp-interactions/src/app.module';

describe('lcp-mcp-interactions health (e2e)', () => {
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
});
