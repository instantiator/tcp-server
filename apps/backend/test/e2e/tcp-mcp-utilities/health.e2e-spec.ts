// tcp-mcp-utilities is stateless: no database or tcp-server, so it boots alone.
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../../../apps/tcp-mcp-utilities/src/app.module';

describe('tcp-mcp-utilities health (e2e)', () => {
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

  it('GET /health responds ok and names the service', () =>
    request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect((res) => {
        const body = res.body as {
          status: string;
          details?: Record<string, { name?: string }>;
        };
        expect(body.status).toBe('ok');
        expect(body.details?.service?.name).toBe('tcp-mcp-utilities');
      }));
});
