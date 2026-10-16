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

  describe('for people (001.03)', () => {
    describe('reading', () => {
      let companyId: string;
      let first: string;
      beforeAll(async () => {
        companyId = await newCompany();
        await records.createTable(companyId, ORDERS, null);
        await records.createTable(
          companyId,
          { ...ORDERS, name: 'empty' },
          null,
        );
        first = (await records.insert(companyId, 'orders', order(1))).record.id;
        await records.insert(companyId, 'orders', order(2));
        await records.insert(companyId, 'orders', order(3));
        // Touch the oldest, so it becomes the most recently changed.
        await records.update(companyId, 'orders', { id: first }, { qty: 7 });
      });

      it('lists tables with their record counts', async () => {
        const summaries = await records.listTableSummaries(companyId);
        expect(summaries.map((t) => [t.name, t.records])).toEqual([
          ['empty', 0],
          ['orders', 3],
        ]);
        expect(Date.parse(summaries[1].updatedAt)).not.toBeNaN();
      });

      it('reads rows most recently changed first, with timestamps', async () => {
        const { rows, total, truncated, definition } = await records.readRows(
          companyId,
          'orders',
        );
        expect(definition.primaryKey).toEqual(['order_id']);
        expect(total).toBe(3);
        expect(truncated).toBe(false);
        expect(rows[0]).toMatchObject({ id: first, version: 2 });
        expect(rows[0].updatedAt >= rows[1].updatedAt).toBe(true);
        expect(rows[0].createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
      });

      it('cuts the rows at the cap and says so', async () => {
        const read = await records.readRows(companyId, 'orders', 2);
        expect(read.rows).toHaveLength(2);
        expect(read).toMatchObject({ total: 3, truncated: true });
      });

      it('reads one row, and answers an unknown id as not found', async () => {
        await expect(
          records.readRow(companyId, 'orders', first),
        ).resolves.toMatchObject({ id: first, data: { qty: 7 } });
        await expect(
          records.readRow(companyId, 'orders', 'not-a-uuid'),
        ).rejects.toMatchObject({ code: 'not_found' });
      });
    });

    it('walks a whole table in batches, oldest first, with no repeats', async () => {
      const companyId = await newCompany();
      await records.createTable(companyId, ORDERS, null);
      const rows = Array.from({ length: 2500 }, (_, i) => order(i + 1));
      await records.insertMany(companyId, 'orders', rows);
      const batches: number[] = [];
      const seen: unknown[] = [];
      await records.forEachRowBatch(companyId, 'orders', (batch) => {
        batches.push(batch.length);
        seen.push(...batch.map((r) => r['order_id']));
      });
      expect(batches).toEqual([1000, 1000, 500]);
      // In the order they were added, though one insertMany added them all.
      expect(seen).toEqual(rows.map((r) => r.order_id));
    });

    describe('insertMany', () => {
      let companyId: string;
      beforeAll(async () => {
        companyId = await newCompany();
        await records.createTable(companyId, ORDERS, null);
        await records.insert(companyId, 'orders', order(1));
      });

      it('inserts nothing when any row fails, and names every failing row', async () => {
        const result = await records.insertMany(companyId, 'orders', [
          order(10),
          order(11, { qty: 0 }),
          order(12),
          { order_id: 'A13' },
        ]);
        expect(result.inserted).toBe(0);
        expect(result.errors.map((e) => e.row)).toEqual([2, 4]);
        expect(result.errors[0].message).toMatch(/qty must be >= 1/);
        expect((await records.query(companyId, 'orders', {})).total).toBe(1);
      });

      it('counts rows whose key is already held, in the table or earlier in the batch', async () => {
        const result = await records.insertMany(companyId, 'orders', [
          order(1),
          order(20),
          order(20),
          order(21),
        ]);
        expect(result).toEqual({ inserted: 2, alreadyExists: 2, errors: [] });
      });

      it('gives one row per key when two batches with the same keys race', async () => {
        const batch = [order(30), order(31), order(32)];
        const results = await Promise.all([
          records.insertMany(companyId, 'orders', batch),
          records.insertMany(companyId, 'orders', batch),
        ]);
        expect(results.map((r) => r.inserted).sort()).toEqual([0, 3]);
        const [{ count }] = await ds.query<{ count: number }[]>(
          `SELECT count(*)::int AS count FROM "record"
           WHERE "companyId" = $1 AND "data" ->> 'order_id' IN ('A30', 'A31', 'A32')`,
          [companyId],
        );
        expect(count).toBe(3);
      });

      it('refuses more rows than the limit', async () => {
        const many = Array.from({ length: 10_001 }, (_, i) => order(i));
        await expect(
          records.insertMany(companyId, 'orders', many),
        ).rejects.toThrow(/at most 10000/);
      });
    });

    describe('version checks', () => {
      let companyId: string;
      let id: string;
      beforeAll(async () => {
        companyId = await newCompany();
        await records.createTable(companyId, ORDERS, null);
        id = (await records.insert(companyId, 'orders', order(1))).record.id;
      });

      it('refuses an update or delete from a stale version, and keeps the record', async () => {
        await records.update(companyId, 'orders', { id }, { qty: 2 }, 1);
        await expect(
          records.update(companyId, 'orders', { id }, { qty: 3 }, 1),
        ).rejects.toMatchObject({ code: 'stale' });
        await expect(
          records.delete(companyId, 'orders', { id }, 1),
        ).rejects.toMatchObject({ code: 'stale' });
        await expect(
          records.readRow(companyId, 'orders', id),
        ).resolves.toMatchObject({ version: 2, data: { qty: 2 } });
        await records.delete(companyId, 'orders', { id }, 2);
      });

      it('marks a key clash as a conflict', async () => {
        const a = await records.insert(companyId, 'orders', order(5));
        await records.insert(companyId, 'orders', order(6));
        await expect(
          records.update(
            companyId,
            'orders',
            { id: a.record.id },
            { order_id: 'A6' },
          ),
        ).rejects.toMatchObject({ code: 'conflict' });
      });
    });

    describe('clear and drop', () => {
      let companyA: string;
      let companyB: string;
      beforeAll(async () => {
        companyA = await newCompany();
        companyB = await newCompany();
        for (const c of [companyA, companyB]) {
          await records.createTable(c, ORDERS, null);
          await records.insertMany(c, 'orders', [order(1), order(2)]);
        }
      });

      it('clears the records and their keys, but keeps the table', async () => {
        expect(await records.clearTable(companyA, 'orders')).toBe(2);
        expect(await records.listTables(companyA)).toHaveLength(1);
        // The keys went too, so the same orders can be added again.
        await expect(
          records.insert(companyA, 'orders', order(1)),
        ).resolves.toMatchObject({ status: 'inserted' });
        expect((await records.query(companyB, 'orders', {})).total).toBe(2);
      });

      it('drops the table and reports what it held', async () => {
        const dropped = await records.dropTable(companyA, 'orders');
        expect(dropped).toMatchObject({
          removed: 1,
          definition: { name: 'orders' },
        });
        expect(await records.listTables(companyA)).toEqual([]);
        const [{ count }] = await ds.query<{ count: number }[]>(
          `SELECT count(*)::int AS count FROM "record_key" WHERE "tableId" = $1`,
          [dropped.definition.id],
        );
        expect(count).toBe(0);
      });

      it("can't clear, drop or read another company's table", async () => {
        const empty = await newCompany();
        for (const call of [
          records.clearTable(empty, 'orders'),
          records.dropTable(empty, 'orders'),
          records.readRows(empty, 'orders'),
        ]) {
          await expect(call).rejects.toMatchObject({ code: 'not_found' });
        }
        expect((await records.query(companyB, 'orders', {})).total).toBe(2);
      });
    });
  });

  describe('data protection (001.04)', () => {
    describe('the do-not-store list', () => {
      let companyId: string;
      beforeAll(async () => {
        companyId = await newCompany();
      });

      it('adds, lists, edits and removes an entry', async () => {
        const added = await records.addDoNotStore(
          companyId,
          { value: '  Ann   Lee ', note: 'Asked by email' },
          { role: 'user', id: 'user-1' },
        );
        expect(added).toMatchObject({
          value: 'Ann   Lee',
          note: 'Asked by email',
          addedByRole: 'user',
          addedById: 'user-1',
        });
        const edited = await records.updateDoNotStore(companyId, added.id, {
          value: 'Ann Lee-Smith',
        });
        expect(edited).toMatchObject({
          value: 'Ann Lee-Smith',
          note: 'Asked by email',
        });
        expect(await records.listDoNotStore(companyId)).toEqual([edited]);
        await records.removeDoNotStore(companyId, added.id);
        expect(await records.listDoNotStore(companyId)).toEqual([]);
      });

      it('refuses the same entry twice, in another case or spacing', async () => {
        await records.addDoNotStore(
          companyId,
          { value: 'bob@example.com' },
          { role: 'agent', id: null },
        );
        await expect(
          records.addDoNotStore(
            companyId,
            { value: ' BOB@example.com ' },
            { role: 'user', id: 'u' },
          ),
        ).rejects.toMatchObject({ code: 'conflict' });
      });

      it.each(['ab', '---', ''])(
        'refuses %j as too short to mean anyone',
        async (value) => {
          await expect(
            records.addDoNotStore(
              companyId,
              { value },
              { role: 'user', id: 'u' },
            ),
          ).rejects.toThrow(/at least three characters/);
        },
      );

      it('matches whole words in text fields only', async () => {
        await records.addDoNotStore(
          companyId,
          { value: 'Cara Diaz' },
          { role: 'user', id: 'u' },
        );
        expect(
          await records.doNotStoreMatches(companyId, [
            {
              customer: 'Mrs CARA  diaz',
              note: 'Deliver to Cara Diazepam Ltd',
              qty: 1,
            },
          ]),
        ).toEqual(['customer']);
      });

      it("keeps one company's list from another", async () => {
        const other = await newCompany();
        expect(await records.listDoNotStore(other)).toEqual([]);
        expect(
          await records.doNotStoreMatches(other, [{ customer: 'Cara Diaz' }]),
        ).toEqual([]);
        const [entry] = await records.listDoNotStore(companyId);
        await expect(
          records.removeDoNotStore(other, entry.id),
        ).rejects.toMatchObject({ code: 'not_found' });
        await expect(
          records.updateDoNotStore(other, entry.id, { note: 'x' }),
        ).rejects.toMatchObject({ code: 'not_found' });
      });
    });

    describe('search, selection export and bulk delete', () => {
      let companyId: string;
      beforeAll(async () => {
        companyId = await newCompany();
        await records.createTable(companyId, ORDERS, null);
        await records.createTable(
          companyId,
          {
            name: 'contacts',
            purpose: 'People.',
            schema: {
              type: 'object',
              properties: { email: { type: 'string' } },
              required: ['email'],
            },
            primaryKey: ['email'],
          },
          null,
        );
        await records.insert(companyId, 'orders', order(1)); // Ann
        await records.insert(companyId, 'orders', order(2)); // Bob
        await records.insert(
          companyId,
          'orders',
          order(3, { note: '50%_off' }),
        );
        await records.insert(companyId, 'contacts', {
          email: 'ann@example.com',
        });
      });

      it('finds rows in every table, grouped by table, in any case', async () => {
        const result = await records.search(companyId, 'ANN');
        expect(result.truncated).toBe(false);
        expect(
          result.groups.map((g) => [g.definition.name, g.rows.length]),
        ).toEqual([
          ['contacts', 1],
          ['orders', 2],
        ]);
      });

      it('takes %, _ and \\ literally', async () => {
        const result = await records.search(companyId, '%_');
        expect(result.groups.flatMap((g) => g.rows.map((r) => r.data))).toEqual(
          [expect.objectContaining({ note: '50%_off' })],
        );
      });

      it("never finds another company's rows", async () => {
        const other = await newCompany();
        expect((await records.search(other, 'Ann')).groups).toEqual([]);
      });

      it('refuses a search too short to be useful', async () => {
        await expect(records.search(companyId, ' a ')).rejects.toThrow(
          /at least 2/,
        );
      });

      it('exports only the chosen rows', async () => {
        const { groups } = await records.search(companyId, 'Bob');
        const ids = groups[0].rows.map((r) => r.id);
        expect(await records.readRowsById(companyId, 'orders', ids)).toEqual([
          order(2),
        ]);
      });

      it('deletes chosen rows all or none, refusing a stale version', async () => {
        const { rows } = await records.readRows(companyId, 'orders');
        const refs = rows.map((r) => ({ id: r.id, version: r.version }));
        await expect(
          records.deleteRows(companyId, 'orders', [
            refs[0],
            { ...refs[1], version: refs[1].version + 1 },
          ]),
        ).rejects.toMatchObject({ code: 'stale' });
        expect((await records.readRows(companyId, 'orders')).total).toBe(3);

        expect(
          await records.deleteRows(companyId, 'orders', refs.slice(0, 2)),
        ).toBe(2);
        expect((await records.readRows(companyId, 'orders')).total).toBe(1);
      });

      it("can't delete another company's rows", async () => {
        const { rows } = await records.readRows(companyId, 'orders');
        const other = await newCompany();
        await records.createTable(other, ORDERS, null);
        await expect(
          records.deleteRows(other, 'orders', [
            { id: rows[0].id, version: rows[0].version },
          ]),
        ).rejects.toMatchObject({ code: 'stale' });
        expect((await records.readRows(companyId, 'orders')).total).toBe(1);
      });
    });

    describe('retention', () => {
      let companyId: string;
      const NOW = new Date('2026-10-12T12:00:00Z');
      const noErrors = (table: string, err: unknown) => {
        throw new Error(`sweeping ${table} failed: ${String(err)}`);
      };

      beforeAll(async () => {
        companyId = await newCompany();
        await records.createTable(companyId, ORDERS, null);
      });

      it('refuses a field that is not a date, and silly lengths', async () => {
        await expect(
          records.setRetention(companyId, 'orders', { days: 30, from: 'note' }),
        ).rejects.toThrow(/neither/);
        await expect(
          records.setRetention(companyId, 'orders', {
            days: 0,
            from: 'updated',
          }),
        ).rejects.toThrow(/whole number of days/);
      });

      it('deletes rows past a date field, keeping blank dates and other tables', async () => {
        await records.insert(
          companyId,
          'orders',
          order(1, { ordered_on: '2026-01-01' }),
        );
        await records.insert(
          companyId,
          'orders',
          order(2, { ordered_on: '2026-10-01' }),
        );
        await records.insert(companyId, 'orders', order(3));
        const other = await newCompany();
        await records.createTable(other, ORDERS, null);
        await records.insert(
          other,
          'orders',
          order(1, { ordered_on: '2026-01-01' }),
        );

        const definition = await records.setRetention(companyId, 'orders', {
          days: 30,
          from: 'ordered_on',
        });
        expect(definition.retention).toEqual({ days: 30, from: 'ordered_on' });
        expect(
          (await records.describeTable(companyId, 'orders')).retention,
        ).toEqual({ days: 30, from: 'ordered_on' });

        const swept = await records.sweepRetention(NOW, noErrors);

        expect(swept).toContainEqual({
          companyId,
          table: 'orders',
          deleted: 1,
        });
        const left = (await records.readRows(companyId, 'orders')).rows.map(
          (r) => r.data.order_id,
        );
        expect(left.sort()).toEqual(['A2', 'A3']);
        expect((await records.readRows(other, 'orders')).total).toBe(1);
      });

      it('deletes rows not updated for the set days, and stops once cleared', async () => {
        await records.setRetention(companyId, 'orders', {
          days: 1,
          from: 'updated',
        });
        const later = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
        await records.setRetention(companyId, 'orders', null);
        expect(
          await records.sweepRetention(later, noErrors),
        ).not.toContainEqual(expect.objectContaining({ companyId }));
        await records.setRetention(companyId, 'orders', {
          days: 1,
          from: 'updated',
        });
        expect(await records.sweepRetention(later, noErrors)).toContainEqual({
          companyId,
          table: 'orders',
          deleted: 2,
        });
      });
    });
  });

  describe('column changes (001.06)', () => {
    /** The table that prompted 001.06: keyed on when, with nowhere to say which animal. */
    const FEEDINGS: NewTable = {
      name: 'feedings',
      purpose: 'When the animals were fed.',
      schema: {
        properties: {
          feeding_date: { type: 'string', format: 'date' },
          feeding_time: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['feeding_date', 'feeding_time'],
      },
      primaryKey: ['feeding_date', 'feeding_time'],
    };
    const PEOPLE = { allowNarrow: true };
    const AGENT = { allowNarrow: false };

    /** A fresh company with a feedings table holding the chicken at 08:00 and the cat at 09:00. */
    async function fed(): Promise<string> {
      const companyId = await newCompany();
      await records.createTable(companyId, FEEDINGS, null);
      for (const time of ['08:00', '09:00']) {
        await records.insert(companyId, 'feedings', {
          feeding_date: '2026-10-12',
          feeding_time: time,
        });
      }
      return companyId;
    }

    it('fixes the feedings table: add animal, fill it in, widen the key, then two animals fed at once', async () => {
      const companyId = await fed();
      await records.alterTable(
        companyId,
        'feedings',
        { op: 'add_column', column: 'animal', type: 'string' },
        AGENT,
      );
      await expect(
        records.alterTable(
          companyId,
          'feedings',
          {
            op: 'set_primary_key',
            fields: ['feeding_date', 'feeding_time', 'animal'],
          },
          AGENT,
        ),
      ).rejects.toThrow(/2 records have no value for 'animal'.*update/);

      for (const [time, animal] of [
        ['08:00', 'chicken'],
        ['09:00', 'cat'],
      ]) {
        await records.update(
          companyId,
          'feedings',
          { key: { feeding_date: '2026-10-12', feeding_time: time } },
          { animal },
        );
      }
      const { definition, rewritten } = await records.alterTable(
        companyId,
        'feedings',
        {
          op: 'set_primary_key',
          fields: ['feeding_date', 'feeding_time', 'animal'],
        },
        AGENT,
      );
      expect(rewritten).toBe(0);
      expect(definition.primaryKey).toEqual([
        'feeding_date',
        'feeding_time',
        'animal',
      ]);
      expect(definition.schema.required).toContain('animal');

      const dog = await records.insert(companyId, 'feedings', {
        feeding_date: '2026-10-12',
        feeding_time: '08:00',
        animal: 'dog',
      });
      expect(dog.status).toBe('inserted');
      const again = await records.insert(companyId, 'feedings', {
        feeding_date: '2026-10-12',
        feeding_time: '08:00',
        animal: 'chicken',
      });
      expect(again.status).toBe('already_exists');
      const byKey = await records.update(
        companyId,
        'feedings',
        {
          key: {
            feeding_date: '2026-10-12',
            feeding_time: '09:00',
            animal: 'cat',
          },
        },
        { note: 'ate it all' },
      );
      expect(byKey.record.data['note']).toBe('ate it all');
    });

    it('gives every record a default, bumping its version but not its update time', async () => {
      const companyId = await fed();
      const before = (await records.readRows(companyId, 'feedings')).rows;
      const { definition, rewritten } = await records.alterTable(
        companyId,
        'feedings',
        {
          op: 'add_column',
          column: 'portion',
          type: 'integer',
          default: 1,
          required: true,
        },
        AGENT,
      );
      expect(rewritten).toBe(2);
      expect(definition.schema.properties['portion']).toEqual({
        type: 'integer',
      });
      expect(definition.schema.required).toContain('portion');
      const after = (await records.readRows(companyId, 'feedings')).rows;
      for (const row of after) {
        const was = before.find((r) => r.id === row.id)!;
        expect(row.data['portion']).toBe(1);
        expect(row.version).toBe(was.version + 1);
        expect(row.updatedAt).toBe(was.updatedAt);
      }
      // Required now holds for new records too.
      await expect(
        records.insert(companyId, 'feedings', {
          feeding_date: '2026-10-13',
          feeding_time: '08:00',
        }),
      ).rejects.toThrow(/portion/);
    });

    it('leaves records alone when a column has no default, and refuses required without one', async () => {
      const companyId = await fed();
      await expect(
        records.alterTable(
          companyId,
          'feedings',
          {
            op: 'add_column',
            column: 'animal',
            type: 'string',
            required: true,
          },
          AGENT,
        ),
      ).rejects.toThrow(/give a default/);
      const before = (await records.readRows(companyId, 'feedings')).rows;
      const { rewritten } = await records.alterTable(
        companyId,
        'feedings',
        { op: 'add_column', column: 'animal', type: 'string' },
        AGENT,
      );
      expect(rewritten).toBe(0);
      const after = (await records.readRows(companyId, 'feedings')).rows;
      expect(after.map((r) => r.version)).toEqual(before.map((r) => r.version));
      expect(after.every((r) => !('animal' in r.data))).toBe(true);
    });

    it('renames a key field everywhere: data, schema, key, retention and lookups', async () => {
      const companyId = await fed();
      await records.setRetention(companyId, 'feedings', {
        days: 30,
        from: 'feeding_date',
      });
      const { definition, rewritten } = await records.alterTable(
        companyId,
        'feedings',
        { op: 'rename_column', column: 'feeding_date', newName: 'fed_on' },
        AGENT,
      );
      expect(rewritten).toBe(2);
      expect(Object.keys(definition.schema.properties).sort()).toEqual([
        'fed_on',
        'feeding_time',
        'note',
      ]);
      expect(definition.schema.required).toEqual(['fed_on', 'feeding_time']);
      expect(definition.primaryKey).toEqual(['fed_on', 'feeding_time']);
      expect(definition.retention).toEqual({ days: 30, from: 'fed_on' });
      expect(await records.describeTable(companyId, 'feedings')).toEqual(
        definition,
      );

      const rows = (await records.readRows(companyId, 'feedings')).rows;
      expect(rows.every((r) => r.data['fed_on'] === '2026-10-12')).toBe(true);
      expect(rows.every((r) => !('feeding_date' in r.data))).toBe(true);

      const found = await records.update(
        companyId,
        'feedings',
        { key: { fed_on: '2026-10-12', feeding_time: '08:00' } },
        { note: 'found by the new name' },
      );
      expect(found.record.data['note']).toBe('found by the new name');
      const repeat = await records.insert(companyId, 'feedings', {
        fed_on: '2026-10-12',
        feeding_time: '09:00',
      });
      expect(repeat.status).toBe('already_exists');
      await expect(
        records.insert(companyId, 'feedings', {
          feeding_date: '2026-10-14',
          feeding_time: '09:00',
        }),
      ).rejects.toThrow(/feeding_date/);
    });

    it('deletes a column from every record, but never a key field', async () => {
      const companyId = await fed();
      await records.update(
        companyId,
        'feedings',
        { key: { feeding_date: '2026-10-12', feeding_time: '08:00' } },
        { note: 'hungry' },
      );
      await expect(
        records.alterTable(
          companyId,
          'feedings',
          { op: 'delete_column', column: 'feeding_time' },
          PEOPLE,
        ),
      ).rejects.toThrow(/take it out of the key first/);
      const { definition, rewritten } = await records.alterTable(
        companyId,
        'feedings',
        { op: 'delete_column', column: 'note' },
        PEOPLE,
      );
      expect(rewritten).toBe(1);
      expect(definition.schema.properties).not.toHaveProperty('note');
      const rows = (await records.readRows(companyId, 'feedings')).rows;
      expect(rows.every((r) => !('note' in r.data))).toBe(true);
    });

    it('refuses a key that would not tell records apart, with examples, and leaves the old key working', async () => {
      const companyId = await fed();
      await expect(
        records.alterTable(
          companyId,
          'feedings',
          { op: 'set_primary_key', fields: ['feeding_date'] },
          PEOPLE,
        ),
      ).rejects.toThrow(
        /1 value is shared, e\.g\. feeding_date="2026-10-12" \(2 records\)/,
      );
      await expect(
        records.alterTable(
          companyId,
          'feedings',
          { op: 'set_primary_key', fields: ['feeding_date'] },
          AGENT,
        ),
      ).rejects.toThrow(/request_user_input/);
      const repeat = await records.insert(companyId, 'feedings', {
        feeding_date: '2026-10-12',
        feeding_time: '08:00',
      });
      expect(repeat.status).toBe('already_exists');
    });

    it('lets people narrow a key when the records allow it', async () => {
      const companyId = await fed();
      const { definition } = await records.alterTable(
        companyId,
        'feedings',
        { op: 'set_primary_key', fields: ['feeding_time'] },
        PEOPLE,
      );
      expect(definition.primaryKey).toEqual(['feeding_time']);
      const sameTime = await records.insert(companyId, 'feedings', {
        feeding_date: '2026-10-13',
        feeding_time: '08:00',
      });
      expect(sameTime.status).toBe('already_exists');
    });

    it('never stores a record under a column name a concurrent rename removed', async () => {
      const companyId = await fed();
      const inserts = Array.from({ length: 20 }, (_, i) =>
        records
          .insert(companyId, 'feedings', {
            feeding_date: '2026-11-01',
            feeding_time: `${String(i).padStart(2, '0')}:00`,
            note: `n${i}`,
          })
          .then(
            () => 'inserted',
            (e: unknown) => {
              expect(e).toBeInstanceOf(RecordsError);
              return 'refused';
            },
          ),
      );
      const rename = records.alterTable(
        companyId,
        'feedings',
        { op: 'rename_column', column: 'note', newName: 'remark' },
        AGENT,
      );
      const [outcomes] = await Promise.all([Promise.all(inserts), rename]);

      const rows = (await records.readRows(companyId, 'feedings')).rows;
      expect(rows.some((r) => 'note' in r.data)).toBe(false);
      expect(rows.filter((r) => 'remark' in r.data)).toHaveLength(
        outcomes.filter((o) => o === 'inserted').length,
      );
    });

    it('lets exactly one of a key change and a clashing insert win', async () => {
      const companyId = await fed();
      const [rekeyed, inserted] = await Promise.allSettled([
        records.alterTable(
          companyId,
          'feedings',
          { op: 'set_primary_key', fields: ['feeding_time'] },
          PEOPLE,
        ),
        records.insert(companyId, 'feedings', {
          feeding_date: '2026-10-13',
          feeding_time: '08:00',
        }),
      ]);
      expect(inserted.status).toBe('fulfilled');
      const insertStatus =
        inserted.status === 'fulfilled' ? inserted.value.status : undefined;
      // Either the key changed first, and the insert found 08:00 taken; or
      // the insert landed first, and the key change found a clash.
      if (rekeyed.status === 'fulfilled') {
        expect(insertStatus).toBe('already_exists');
      } else {
        expect(insertStatus).toBe('inserted');
        expect(String(rekeyed.reason)).toMatch(/would not tell records apart/);
      }
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
      await separate.addDoNotStore(
        companyId,
        { value: 'Ann Lee' },
        { role: 'user', id: 'u' },
      );
      await separate.deleteCompany(companyId);
      expect(await separate.listDoNotStore(companyId)).toEqual([]);
    });

    it('has the company foreign keys in the shared database', async () => {
      const fks = await ds.query<{ conname: string }[]>(
        `SELECT conname FROM pg_constraint WHERE conname LIKE 'FK_record%company' ORDER BY conname`,
      );
      expect(fks.map((f) => f.conname)).toEqual([
        'FK_record_company',
        'FK_record_do_not_store_company',
        'FK_record_table_company',
      ]);
    });
  });
});
