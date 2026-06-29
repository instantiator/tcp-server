import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../../../apps/lcp-mcp-interactions/src/app.module';

const initializeRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '0.0.1' },
  },
};

describe('lcp-mcp-interactions MCP endpoint (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication({ rawBody: true });
    await app.init();
  });

  afterAll(() => app.close());

  it('POST /mcp returns 200 for a valid initialize request', () =>
    request(app.getHttpServer())
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeRequest)
      .expect((res) => expect([200, 202]).toContain(res.status)));

  it('GET /mcp returns 405', () =>
    request(app.getHttpServer()).get('/mcp').expect(405));

  it('DELETE /mcp returns 405', () =>
    request(app.getHttpServer()).delete('/mcp').expect(405));
});
