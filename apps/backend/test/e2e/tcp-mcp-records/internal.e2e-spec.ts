// tcp-mcp-records requires a real Postgres connection, provisioned by the e2e
// global setup — which also runs the records migrations.
import { RecordsService } from '@tcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../../../apps/tcp-mcp-records/src/app.module';
import { requireEnv } from '../../support/require-env';

requireEnv('DATABASE_URL');
const INTERNAL_API_KEY = requireEnv('INTERNAL_API_KEY');

/** The smallest valid table, for giving a company something to delete. */
const NOTES = {
  name: 'notes',
  purpose: 'Notes.',
  schema: {
    type: 'object',
    properties: { ref: { type: 'string' } },
    required: ['ref'],
  },
  primaryKey: ['ref'],
};

describe('tcp-mcp-records internal routes (e2e)', () => {
  let app: INestApplication<App>;
  let ds: DataSource;
  let records: RecordsService;
  const companyIds: string[] = [];

  /** A company row with one record table. */
  async function companyWithTable(): Promise<string> {
    const [{ id }] = await ds.query<{ id: string }[]>(
      `INSERT INTO "tcp_company" ("slug", "name", "description") VALUES ($1, $1, 'e2e') RETURNING "id"`,
      [`records-internal-${randomUUID().slice(0, 8)}`],
    );
    companyIds.push(id);
    await records.createTable(id, NOTES, null);
    return id;
  }

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    // Listening, not just init() — see agent.e2e-spec.ts for why.
    await app.listen(0);
    ds = app.get(DataSource);
    records = app.get(RecordsService);
  });

  afterAll(async () => {
    await ds.query(`DELETE FROM "tcp_company" WHERE "id" = ANY($1)`, [
      companyIds,
    ]);
    await app.close();
  });

  it('refuses a call with no internal key (401) or the wrong one (403)', async () => {
    const companyId = await companyWithTable();
    const path = `/internal/companies/${companyId}/records`;
    await request(app.getHttpServer()).delete(path).expect(401);
    await request(app.getHttpServer())
      .delete(path)
      .set('X-Internal-Api-Key', 'wrong')
      .expect(403);
    expect(await records.listTables(companyId)).toHaveLength(1);
  });

  it("deletes that company's tables and no other's", async () => {
    const gone = await companyWithTable();
    const kept = await companyWithTable();
    const res = await request(app.getHttpServer())
      .delete(`/internal/companies/${gone}/records`)
      .set('X-Internal-Api-Key', INTERNAL_API_KEY)
      .expect(200);
    expect(res.body).toEqual({ tables: 1 });
    expect(await records.listTables(gone)).toEqual([]);
    expect(await records.listTables(kept)).toHaveLength(1);
  });

  it('rejects an id that is not a UUID', () =>
    request(app.getHttpServer())
      .delete('/internal/companies/not-a-uuid/records')
      .set('X-Internal-Api-Key', INTERNAL_API_KEY)
      .expect(400));
});
