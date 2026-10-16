import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MCP_REGISTRY } from '@tcp/shared';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../../../apps/tcp-server/src/app.module';
import { makeTestJwt } from '../helpers/test-jwt';

describe('McpServersController (e2e)', () => {
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

  it('GET /api/mcp-servers returns 401 without a token', () =>
    request(app.getHttpServer()).get('/api/mcp-servers').expect(401));

  it('GET /api/mcp-servers lists every registered server', () =>
    request(app.getHttpServer())
      .get('/api/mcp-servers')
      .set('Authorization', `Bearer ${makeTestJwt()}`)
      .expect(200)
      .expect((res) => {
        const body = res.body as { name: string; available: boolean }[];
        expect(body.map((s) => s.name)).toEqual(
          MCP_REGISTRY.map((s) => s.name),
        );
        for (const s of body) expect(typeof s.available).toBe('boolean');
      }));
});
