import {
  RecordsError,
  RecordsService,
  TcpCompany,
  TcpRole,
  type NewTable,
} from '@tcp/shared';
import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { RECORDS_MIGRATIONS } from '../../../apps/tcp-mcp-records/src/migrations-list';
import { requireEnv } from '../../support/require-env';

const DATABASE_URL = requireEnv('DATABASE_URL');

/** A small orders table: order_id is the primary key, marketplace_ref a second unique key. */
const ORDERS: NewTable = {
  name: 'orders',
  purpose: 'One row per customer order.',
  schema: {
    type: 'object',
    properties: {
      order_id: { type: 'string' },
      marketplace_ref: { type: 'string' },
      customer: { type: 'string' },
      qty: { type: 'integer', minimum: 1 },
      total: { type: 'number' },
      paid: { type: 'boolean' },
      ordered_on: { type: 'string', format: 'date' },
      note: { type: 'string' },
    },
    required: ['order_id', 'marketplace_ref', 'customer', 'qty', 'total'],
  },
  primaryKey: ['order_id'],
  uniqueKeys: [['marketplace_ref']],
};

function order(n: number, extra: Record<string, unknown> = {}) {
  return {
    order_id: `A${n}`,
    marketplace_ref: `M${n}`,
    customer: n % 2 ? 'Ann' : 'Bob',
    qty: n,
    total: 0.1,
    ...extra,
  };
}

/**
 * Proves {@link RecordsService} against real Postgres: the unique keys hold
 * under concurrent inserts, company scoping holds even with another
 * company's table name or record id, filters bind rather than splice agent
 * input, and totals are exact decimals. Run via ./scripts/run-integration-tests.sh.
 */
describe('RecordsService (integration)', () => {
  let ds: DataSource;
  let companies: Repository<TcpCompany>;
  let records: RecordsService;

  /** A fresh company, so each block owns its tables. */
  async function newCompany(): Promise<string> {
    const suffix = randomUUID().slice(0, 8);
    const company = await companies.save(
      companies.create({
        slug: `records-${suffix}`,
        name: `Records ${suffix}`,
        description: 'test',
      }),
    );
    return company.id;
  }

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      url: DATABASE_URL,
      entities: [TcpCompany, TcpRole],
    });
    await ds.initialize();
    companies = ds.getRepository(TcpCompany);
    records = new RecordsService(ds);
  });

  afterAll(() => ds.destroy());

  describe('create_table', () => {
    let companyId: string;
    beforeAll(async () => {
      companyId = await newCompany();
    });

    it('creates a closed table and lists it', async () => {
      const table = await records.createTable(companyId, ORDERS, null);
      expect(table.schema.additionalProperties).toBe(false);
      expect(await records.listTables(companyId)).toEqual([
        { name: 'orders', purpose: 'One row per customer order.' },
      ]);
    });

    it('refuses a second table of the same name in the company, but not in another company', async () => {
      await expect(
        records.createTable(companyId, ORDERS, null),
      ).rejects.toThrow(/already exists/);
      const other = await newCompany();
      await expect(
        records.createTable(other, ORDERS, null),
      ).resolves.toMatchObject({ name: 'orders' });
    });

    it.each([
      ['a bad name', { name: 'Orders!' }, /table name/],
      [
        'a non-scalar field',
        { schema: { type: 'object', properties: { x: { type: 'array' } } } },
        /field 'x'/,
      ],
      [
        'a misspelt keyword',
        { schema: { ...ORDERS.schema, requird: [] } },
        /not valid JSON Schema/,
      ],
      [
        'a key field that is not required',
        { primaryKey: ['note'] },
        /required/,
      ],
      ['a float key field', { uniqueKeys: [['total']] }, /string or integer/],
      ['an unknown key field', { primaryKey: ['nope'] }, /not a field/],
    ])('refuses %s', async (_label, change, message) => {
      await expect(
        records.createTable(
          companyId,
          { ...ORDERS, name: 'bad', ...change },
          null,
        ),
      ).rejects.toThrow(message);
    });

    it('accepts a schema that leaves out "type": "object"', async () => {
      const untyped = Object.fromEntries(
        Object.entries(ORDERS.schema).filter(([k]) => k !== 'type'),
      );
      const table = await records.createTable(
        companyId,
        { ...ORDERS, name: 'untyped', schema: untyped },
        null,
      );
      expect(table.schema.type).toBe('object');
    });

    it('stops at the per-company table limit', async () => {
      const crowded = await newCompany();
      await ds.query(
        `INSERT INTO "record_table" ("companyId", "name", "purpose", "schema", "primaryKey")
         SELECT $1, 't' || g, 'filler', '{}', '[]' FROM generate_series(1, 50) g`,
        [crowded],
      );
      await expect(records.createTable(crowded, ORDERS, null)).rejects.toThrow(
        /50 tables/,
      );
    });
  });

  describe('insert', () => {
    let companyId: string;
    beforeAll(async () => {
      companyId = await newCompany();
      await records.createTable(companyId, ORDERS, null);
    });

    it('lists every schema problem at once', async () => {
      const failure = records.insert(companyId, 'orders', {
        order_id: 'X',
        qty: 0,
        surprise: true,
      });
      await expect(failure).rejects.toBeInstanceOf(RecordsError);
      await expect(failure).rejects.toThrow(
        /marketplace_ref.*customer|customer.*marketplace_ref/s,
      );
      await expect(failure).rejects.toThrow(/qty must be >= 1/);
      await expect(failure).rejects.toThrow(/surprise/);
    });

    it('answers a repeated insert with the existing record, and says whether it matches', async () => {
      const first = await records.insert(companyId, 'orders', order(1));
      expect(first.status).toBe('inserted');
      const again = await records.insert(companyId, 'orders', order(1));
      expect(again).toMatchObject({
        status: 'already_exists',
        record: { id: first.record.id },
        key: { order_id: 'A1' },
        matches: true,
      });
      const different = await records.insert(
        companyId,
        'orders',
        order(1, { qty: 9 }),
      );
      expect(different).toMatchObject({
        status: 'already_exists',
        matches: false,
      });
    });

    it('treats a clash on a unique key like one on the primary key', async () => {
      const clash = await records.insert(
        companyId,
        'orders',
        order(2, { marketplace_ref: 'M1' }),
      );
      expect(clash).toMatchObject({
        status: 'already_exists',
        key: { marketplace_ref: 'M1' },
      });
    });

    it('lets exactly one of many concurrent inserts of the same key through', async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          records.insert(companyId, 'orders', order(3)),
        ),
      );
      expect(results.filter((r) => r.status === 'inserted')).toHaveLength(1);
      expect(new Set(results.map((r) => r.record.id)).size).toBe(1);
      const [{ count }] = await ds.query<{ count: number }[]>(
        `SELECT count(*)::int AS count FROM "record" r JOIN "record_table" t ON t."id" = r."tableId"
         WHERE t."companyId" = $1 AND r."data" ->> 'order_id' = 'A3'`,
        [companyId],
      );
      expect(count).toBe(1);
    });
  });

  describe('update and delete', () => {
    let companyId: string;
    beforeAll(async () => {
      companyId = await newCompany();
      await records.createTable(companyId, ORDERS, null);
      await records.insert(companyId, 'orders', order(1, { note: 'gift' }));
      await records.insert(companyId, 'orders', order(2));
    });

    it('merges changes, removes null fields, bumps the version and returns the before value', async () => {
      const change = await records.update(
        companyId,
        'orders',
        { key: { order_id: 'A1' } },
        { paid: true, note: null },
      );
      expect(change.before).toMatchObject({ note: 'gift' });
      expect(change.record.data).toMatchObject({ paid: true });
      expect(change.record.data).not.toHaveProperty('note');
      expect(change.record.version).toBe(2);
    });

    it('re-checks the merged record against the schema', async () => {
      await expect(
        records.update(
          companyId,
          'orders',
          { key: { order_id: 'A1' } },
          { qty: 'two' },
        ),
      ).rejects.toThrow(/qty must be integer/);
    });

    it('refuses a key change that would clash, leaving both records as they were', async () => {
      await expect(
        records.update(
          companyId,
          'orders',
          { key: { order_id: 'A2' } },
          { marketplace_ref: 'M1' },
        ),
      ).rejects.toThrow(/already has that key/);
      const { records: rows } = await records.query(companyId, 'orders', {
        filters: [{ field: 'order_id', op: 'eq', value: 'A2' }],
      });
      expect(rows[0].data['marketplace_ref']).toBe('M2');
    });

    it('lets a record take a key value that another record has just given up', async () => {
      await records.update(
        companyId,
        'orders',
        { key: { order_id: 'A2' } },
        { order_id: 'A9' },
      );
      const reused = await records.insert(
        companyId,
        'orders',
        order(2, { marketplace_ref: 'M2b' }),
      );
      expect(reused.status).toBe('inserted');
    });

    it('applies two concurrent updates one after the other', async () => {
      await Promise.all([
        records.update(
          companyId,
          'orders',
          { key: { order_id: 'A1' } },
          { note: 'x' },
        ),
        records.update(
          companyId,
          'orders',
          { key: { order_id: 'A1' } },
          { customer: 'Cat' },
        ),
      ]);
      const { records: rows } = await records.query(companyId, 'orders', {
        filters: [{ field: 'order_id', op: 'eq', value: 'A1' }],
      });
      expect(rows[0].data).toMatchObject({ note: 'x', customer: 'Cat' });
      expect(rows[0].version).toBe(4);
    });

    it('deletes by id and by key, returning what was there', async () => {
      const { records: rows } = await records.query(companyId, 'orders', {
        filters: [{ field: 'order_id', op: 'eq', value: 'A9' }],
      });
      const byId = await records.delete(companyId, 'orders', {
        id: rows[0].id,
      });
      expect(byId.before).toMatchObject({ order_id: 'A9' });
      const byKey = await records.delete(companyId, 'orders', {
        key: { order_id: 'A2' },
      });
      expect(byKey.before).toMatchObject({ marketplace_ref: 'M2b' });
      await expect(
        records.delete(companyId, 'orders', { key: { order_id: 'A2' } }),
      ).rejects.toThrow(/no record matches/);
    });

    it('answers a malformed id as "no record", not a database error', async () => {
      await expect(
        records.delete(companyId, 'orders', { id: 'not-a-uuid' }),
      ).rejects.toBeInstanceOf(RecordsError);
    });
  });

  describe('company isolation', () => {
    let companyA: string;
    let companyB: string;
    let recordId: string;
    beforeAll(async () => {
      companyA = await newCompany();
      companyB = await newCompany();
      await records.createTable(companyA, ORDERS, null);
      recordId = (await records.insert(companyA, 'orders', order(1))).record.id;
    });

    it("can't see another company's table by name", async () => {
      await expect(records.query(companyB, 'orders', {})).rejects.toThrow(
        /no table named/,
      );
      await expect(
        records.aggregate(companyB, 'orders', { op: 'count' }),
      ).rejects.toThrow(/no table named/);
      expect(await records.listTables(companyB)).toEqual([]);
    });

    it("can't reach another company's record by id, even through its own same-named table", async () => {
      await records.createTable(companyB, ORDERS, null);
      await expect(
        records.update(companyB, 'orders', { id: recordId }, { qty: 5 }),
      ).rejects.toThrow(/no record matches/);
      await expect(
        records.delete(companyB, 'orders', { key: { order_id: 'A1' } }),
      ).rejects.toThrow(/no record matches/);
      expect((await records.query(companyB, 'orders', {})).total).toBe(0);
      expect((await records.query(companyA, 'orders', {})).total).toBe(1);
    });
  });

  describe('query and aggregate', () => {
    let companyId: string;
    beforeAll(async () => {
      companyId = await newCompany();
      await records.createTable(companyId, ORDERS, null);
      for (let n = 1; n <= 12; n++) {
        await records.insert(
          companyId,
          'orders',
          order(n, {
            paid: n <= 3,
            ordered_on: `2026-10-${String(n).padStart(2, '0')}`,
            note: n === 5 ? '50% off_sale' : 'plain',
          }),
        );
      }
    });

    const ids = (rows: { data: Record<string, unknown> }[]) =>
      rows.map((r) => r.data['order_id']).sort();

    it('compares numeric fields as numbers, so 10 > 9', async () => {
      const { records: rows } = await records.query(companyId, 'orders', {
        filters: [{ field: 'qty', op: 'gt', value: 9 }],
      });
      expect(ids(rows)).toEqual(['A10', 'A11', 'A12']);
    });

    it.each([
      ['eq', 'customer', 'Ann', 6],
      ['ne', 'customer', 'Ann', 6],
      ['lte', 'qty', 2, 2],
      ['gte', 'ordered_on', '2026-10-11', 2],
      ['lt', 'qty', 2, 1],
      ['in', 'order_id', ['A1', 'A4', 'nope'], 2],
      ['eq', 'paid', true, 3],
      ['ne', 'paid', true, 9],
    ] as const)('%s on %s', async (op, field, value, expected) => {
      const result = await records.query(companyId, 'orders', {
        filters: [{ field, op, value }],
      });
      expect(result.total).toBe(expected);
    });

    it('treats % and _ in a contains value literally', async () => {
      const result = await records.query(companyId, 'orders', {
        filters: [{ field: 'note', op: 'contains', value: '50% OFF_' }],
      });
      expect(ids(result.records)).toEqual(['A5']);
      const none = await records.query(companyId, 'orders', {
        filters: [{ field: 'note', op: 'contains', value: '%' + '_' }],
      });
      expect(none.total).toBe(0);
    });

    it('sorts, pages and reports the total', async () => {
      const page = await records.query(companyId, 'orders', {
        sort: [{ field: 'qty', direction: 'desc' }],
        limit: 5,
        offset: 5,
      });
      expect(page.total).toBe(12);
      expect(page.records.map((r) => r.data['qty'])).toEqual([7, 6, 5, 4, 3]);
      const past = await records.query(companyId, 'orders', { offset: 50 });
      expect(past).toEqual({ records: [], total: 12 });
    });

    it('rejects an unknown field and a wrongly typed value with a clear error', async () => {
      await expect(
        records.query(companyId, 'orders', {
          filters: [{ field: 'colour', op: 'eq', value: 'red' }],
        }),
      ).rejects.toThrow(/unknown field 'colour'.*order_id/);
      await expect(
        records.query(companyId, 'orders', {
          filters: [{ field: 'qty', op: 'eq', value: '3' }],
        }),
      ).rejects.toThrow(/compare it with a number/);
    });

    it('keeps injection attempts in field names and values inert', async () => {
      await expect(
        records.query(companyId, 'orders', {
          filters: [{ field: "customer') OR 1=1 --", op: 'eq', value: 'x' }],
        }),
      ).rejects.toThrow(/unknown field/);
      const sneaky = await records.query(companyId, 'orders', {
        filters: [{ field: 'customer', op: 'eq', value: "Ann' OR '1'='1" }],
      });
      expect(sneaky.total).toBe(0);
      expect((await records.query(companyId, 'orders', {})).total).toBe(12);
    });

    it('totals decimals exactly', async () => {
      const [row] = await records.aggregate(companyId, 'orders', {
        op: 'sum',
        field: 'total',
        filters: [{ field: 'qty', op: 'lte', value: 3 }],
      });
      expect(row).toEqual({ group: {}, value: '0.3' });
    });

    it('groups, keeping the group values typed', async () => {
      const rows = await records.aggregate(companyId, 'orders', {
        op: 'count',
        groupBy: ['customer', 'paid'],
      });
      expect(rows).toContainEqual({
        group: { customer: 'Ann', paid: true },
        value: '2',
      });
      expect(rows).toContainEqual({
        group: { customer: 'Bob', paid: false },
        value: '5',
      });
    });

    it('refuses to sum a text field', async () => {
      await expect(
        records.aggregate(companyId, 'orders', {
          op: 'sum',
          field: 'customer',
        }),
      ).rejects.toThrow(/needs a number field/);
    });
  });

  describe('company deletion', () => {
    it('cascades from the company row in a shared database', async () => {
      const companyId = await newCompany();
      await records.createTable(companyId, ORDERS, null);
      await records.insert(companyId, 'orders', order(1));
      await companies.delete(companyId);
      const [{ count }] = await ds.query<{ count: number }[]>(
        `SELECT count(*)::int AS count FROM "record" WHERE "companyId" = $1`,
        [companyId],
      );
      expect(count).toBe(0);
    });

    it("deleteCompany removes only that company's tables", async () => {
      const gone = await newCompany();
      const kept = await newCompany();
      await records.createTable(gone, ORDERS, null);
      await records.createTable(kept, ORDERS, null);
      expect(await records.deleteCompany(gone)).toBe(1);
      expect(await records.listTables(gone)).toEqual([]);
      expect(await records.listTables(kept)).toHaveLength(1);
    });
  });

  describe('a separate records database', () => {
    const name = `records_scratch_${randomUUID().slice(0, 8)}`;
    let scratch: DataSource;

    beforeAll(async () => {
      await ds.query(`CREATE DATABASE "${name}"`);
      const url = new URL(DATABASE_URL);
      url.pathname = `/${name}`;
      scratch = new DataSource({
        type: 'postgres',
        url: url.toString(),
        migrations: RECORDS_MIGRATIONS,
        migrationsTableName: 'records_migrations',
      });
      await scratch.initialize();
      await scratch.runMigrations();
    });

    afterAll(async () => {
      await scratch.destroy();
      await ds.query(`DROP DATABASE "${name}"`);
    });

    it('migrates without company foreign keys, and still works', async () => {
      const fks = await scratch.query<{ conname: string }[]>(
        `SELECT conname FROM pg_constraint WHERE conname LIKE 'FK_record%company'`,
      );
      expect(fks).toEqual([]);
      const separate = new RecordsService(scratch);
      const companyId = randomUUID();
      await separate.createTable(companyId, ORDERS, null);
      expect(
        (await separate.insert(companyId, 'orders', order(1))).status,
      ).toBe('inserted');
    });

    it('has the company foreign keys in the shared database', async () => {
      const fks = await ds.query<{ conname: string }[]>(
        `SELECT conname FROM pg_constraint WHERE conname LIKE 'FK_record%company' ORDER BY conname`,
      );
      expect(fks.map((f) => f.conname)).toEqual([
        'FK_record_company',
        'FK_record_table_company',
      ]);
    });
  });
});
