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

  it('adds a column with alter_table, then stores records that use it — over the real transport', async () => {
    const ids = { companyId, agentId };
    await callTool(app, 'create_table', {
      ...ids,
      name: 'feedings',
      purpose: 'When the animals were fed',
      schema: {
        properties: {
          feeding_date: { type: 'string', format: 'date' },
          feeding_time: { type: 'string' },
        },
        required: ['feeding_date', 'feeding_time'],
      },
      primary_key: ['feeding_date', 'feeding_time'],
    });
    await callTool(app, 'insert', {
      ...ids,
      table: 'feedings',
      record: { feeding_date: '2026-10-12', feeding_time: '08:00' },
    });

    const altered = JSON.parse(
      await callTool(app, 'alter_table', {
        ...ids,
        table: 'feedings',
        action: 'add_column',
        column: 'animal',
        type: 'string',
        default: 'chicken',
      }),
    ) as { table: { schema: { required: string[] } }; rewritten: number };
    expect(altered.rewritten).toBe(1);

    await callTool(app, 'alter_table', {
      ...ids,
      table: 'feedings',
      action: 'set_primary_key',
      fields: ['feeding_date', 'feeding_time', 'animal'],
    });
    const cat = JSON.parse(
      await callTool(app, 'insert', {
        ...ids,
        table: 'feedings',
        record: {
          feeding_date: '2026-10-12',
          feeding_time: '08:00',
          animal: 'cat',
        },
      }),
    ) as { status: string };
    expect(cat.status).toBe('inserted');

    expect(
      await callTool(app, 'alter_table', {
        ...ids,
        table: 'feedings',
        action: 'delete_column',
        column: 'animal',
      }),
    ).toMatch(/^Error: .*take it out of the key first/);

    // Times kept as text become whole numbers of minutes only where they convert.
    await callTool(app, 'alter_table', {
      ...ids,
      table: 'feedings',
      action: 'add_column',
      column: 'minutes',
      type: 'string',
      default: '15',
    });
    const retyped = JSON.parse(
      await callTool(app, 'alter_table', {
        ...ids,
        table: 'feedings',
        action: 'retype_column',
        column: 'minutes',
        type: 'integer',
      }),
    ) as { table: { schema: { properties: Record<string, unknown> } } };
    expect(retyped.table.schema.properties['minutes']).toEqual({
      type: 'integer',
    });
    expect(
      await callTool(app, 'alter_table', {
        ...ids,
        table: 'feedings',
        action: 'add_unique_key',
        fields: ['minutes'],
      }),
    ).toMatch(/^Nothing was changed/);
  });

  it('refuses to store someone on the do-not-store list an agent added — over the real transport', async () => {
    const identity = { companyId, agentId };
    await callTool(app, 'create_table', {
      ...identity,
      name: 'customers',
      purpose: 'People who order.',
      schema: {
        type: 'object',
        properties: { email: { type: 'string' }, name: { type: 'string' } },
        required: ['email'],
      },
      primary_key: ['email'],
    });
    expect(
      await callTool(app, 'do_not_store', {
        ...identity,
        action: 'add',
        value: 'Ann Lee',
        reason: 'She asked us not to keep her details.',
      }),
    ).toMatch(/^Added/);

    const refused = JSON.parse(
      await callTool(app, 'insert', {
        ...identity,
        table: 'customers',
        record: { email: 'a@example.com', name: 'Mrs ann lee' },
      }),
    ) as { status: string; fields: string[] };
    expect(refused).toMatchObject({ status: 'not_stored', fields: ['name'] });

    const stored = JSON.parse(
      await callTool(app, 'insert', {
        ...identity,
        table: 'customers',
        record: { email: 'b@example.com', name: 'Bob Annlee' },
      }),
    ) as { status: string };
    expect(stored.status).toBe('inserted');

    const query = JSON.parse(
      await callTool(app, 'query', { ...identity, table: 'customers' }),
    ) as { total: number };
    expect(query.total).toBe(1);
  });
});
