// tcp-mcp-records requires a real Postgres connection, provisioned by the e2e
// global setup — which also runs the records migrations.
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../../../apps/tcp-mcp-records/src/app.module';
import { requireEnv } from '../../support/require-env';

requireEnv('DATABASE_URL');

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
    error?: { message: string };
  };
  if (message.error) throw new Error(message.error.message);
  return message.result?.content[0]?.text ?? '';
}

describe('tcp-mcp-records MCP endpoint (e2e)', () => {
  let app: INestApplication<App>;
  let ds: DataSource;
  let companyId: string;
  const agentId = randomUUID();

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication({ rawBody: true });
    // Listening, not just init() — see agent.e2e-spec.ts for why.
    await app.listen(0);
    // The app's own connection: the records server registers no entities,
    // so the company row is written with SQL.
    ds = app.get(DataSource);
    const suffix = randomUUID().slice(0, 8);
    [{ id: companyId }] = await ds.query<{ id: string }[]>(
      `INSERT INTO "tcp_company" ("slug", "name", "description") VALUES ($1, $1, 'e2e') RETURNING "id"`,
      [`records-e2e-${suffix}`],
    );
  });

  afterAll(async () => {
    // Cascades to the company's record tables.
    await ds.query(`DELETE FROM "tcp_company" WHERE "id" = $1`, [companyId]);
    await app.close();
  });

  it('GET /mcp returns 405', () =>
    request(app.getHttpServer()).get('/mcp').expect(405));

  it('DELETE /mcp returns 405', () =>
    request(app.getHttpServer()).delete('/mcp').expect(405));

  it('creates a table, inserts once despite a retry, and totals it exactly — over the real transport', async () => {
    const identity = { companyId, agentId };
    await callTool(app, 'create_table', {
      ...identity,
      name: 'income',
      purpose: 'Money received.',
      schema: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          amount: { type: 'number' },
        },
        required: ['ref', 'amount'],
      },
      primary_key: ['ref'],
    });
    for (const [ref, amount] of [
      ['R1', 0.1],
      ['R2', 0.2],
      ['R2', 0.2],
    ] as const) {
      await callTool(app, 'insert', {
        ...identity,
        table: 'income',
        record: { ref, amount },
      });
    }

    const query = JSON.parse(
      await callTool(app, 'query', { ...identity, table: 'income' }),
    ) as { total: number };
    expect(query.total).toBe(2);

    const totals = JSON.parse(
      await callTool(app, 'aggregate', {
        ...identity,
        table: 'income',
        op: 'sum',
        field: 'amount',
      }),
    ) as { value: string }[];
    expect(totals).toEqual([{ group: {}, value: '0.3' }]);
  });
});
