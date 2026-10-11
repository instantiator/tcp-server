// tcp-mcp-utilities is stateless: no database or tcp-server, so it boots alone.
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../../../apps/tcp-mcp-utilities/src/app.module';

/**
 * Calls an MCP tool over the real `/mcp` transport and returns its text.
 * The stateless transport answers in SSE framing (`data: {...}`), as in the
 * tcp-mcp-memory e2e spec.
 */
async function callTool(
  app: INestApplication<App>,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/mcp')
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream')
    .send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    })
    .expect(200);
  const match = /data: (.+)/.exec(res.text);
  if (!match) throw new Error(`No SSE data event in response: ${res.text}`);
  const message = JSON.parse(match[1]) as {
    result?: { content: { text: string }[] };
  };
  return message.result?.content[0]?.text ?? '';
}

describe('tcp-mcp-utilities MCP endpoint (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication({ rawBody: true });
    // Listening, not just init() — see agent.e2e-spec.ts for why.
    await app.listen(0);
  });

  afterAll(() => app.close());

  it('GET /mcp returns 405', () =>
    request(app.getHttpServer()).get('/mcp').expect(405));

  it('DELETE /mcp returns 405', () =>
    request(app.getHttpServer()).delete('/mcp').expect(405));

  it('calculate works out a VAT-inclusive total exactly, over the real transport', async () => {
    expect(
      await callTool(app, 'calculate', {
        expression: 'round(3 * 4.99 * 120%, 2)',
      }),
    ).toBe('17.96');
  });
});
