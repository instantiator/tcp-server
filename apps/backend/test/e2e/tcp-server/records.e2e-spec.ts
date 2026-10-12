import {
  AuditEvent,
  CompanyUser,
  RecordsService,
  TcpCompany,
  TcpRole,
  type NewTable,
} from '@tcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import { strFromU8, unzipSync } from 'fflate';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../../apps/tcp-server/src/app.module';
import { makeTestJwt } from '../helpers/test-jwt';

const ORDERS: NewTable = {
  name: 'orders',
  purpose: 'One row per order.',
  schema: {
    type: 'object',
    properties: {
      order_id: { type: 'string' },
      qty: { type: 'integer', minimum: 1 },
      note: { type: 'string' },
    },
    required: ['order_id', 'qty'],
  },
  primaryKey: ['order_id'],
};

/** Starts every CSV download, so Excel reads it as UTF-8. */
const BOM = '\uFEFF';

/** A record as the API returns it. */
interface Row {
  id: string;
  data: Record<string, unknown>;
  version: number;
  updatedAt: string;
}

/**
 * The records REST API for people (001.03): reading, correcting, appending
 * CSV, clearing, deleting and exporting a company's record tables, with every
 * change audited as the user and every route closed to non-members.
 */
describe('Records API (e2e)', () => {
  let app: INestApplication<App>;
  let records: RecordsService;
  let companyRepo: Repository<TcpCompany>;
  let roleRepo: Repository<TcpRole>;
  let userRepo: Repository<CompanyUser>;
  let auditRepo: Repository<AuditEvent>;

  const aliceJwt = makeTestJwt({ sub: 'alice', email: 'alice@example.com' });
  const bobJwt = makeTestJwt({ sub: 'bob', email: 'bob@example.com' });
  let companyId: string;
  let base: string;

  const as = (jwt: string) => ({
    get: (path: string) =>
      request(app.getHttpServer())
        .get(`${base}${path}`)
        .set('Authorization', `Bearer ${jwt}`),
    post: (path: string) =>
      request(app.getHttpServer())
        .post(`${base}${path}`)
        .set('Authorization', `Bearer ${jwt}`),
    patch: (path: string) =>
      request(app.getHttpServer())
        .patch(`${base}${path}`)
        .set('Authorization', `Bearer ${jwt}`),
    delete: (path: string) =>
      request(app.getHttpServer())
        .delete(`${base}${path}`)
        .set('Authorization', `Bearer ${jwt}`),
    put: (path: string) =>
      request(app.getHttpServer())
        .put(`${base}${path}`)
        .set('Authorization', `Bearer ${jwt}`),
  });
  const alice = () => as(aliceJwt);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    // Listening, not just init() — see agent.e2e-spec.ts for why.
    await app.listen(0);
    records = moduleFixture.get(RecordsService);
    companyRepo = moduleFixture.get(getRepositoryToken(TcpCompany));
    roleRepo = moduleFixture.get(getRepositoryToken(TcpRole));
    userRepo = moduleFixture.get(getRepositoryToken(CompanyUser));
    auditRepo = moduleFixture.get(getRepositoryToken(AuditEvent));

    const slug = `records-${Date.now()}`;
    const res = await request(app.getHttpServer())
      .post('/api/company')
      .set('Authorization', `Bearer ${aliceJwt}`)
      .send({ slug, name: slug, description: 'records e2e' })
      .expect(201);
    companyId = (res.body as { id: string }).id;
    // By slug, so the routes are shown to accept either form.
    base = `/api/company/${slug}/records`;
    // Agents make tables; there is no route for it.
    await records.createTable(companyId, ORDERS, null);
  });

  afterAll(async () => {
    await records.deleteCompany(companyId);
    await userRepo.delete({ companyId: companyId as UUID });
    await roleRepo.delete({ companyId: companyId as UUID });
    await companyRepo.delete({ id: companyId as UUID });
    await app.close();
  });

  /** The user-made records changes audited for this company, oldest first. */
  const userChanges = async () =>
    (
      await auditRepo.find({
        where: { companyId: companyId as UUID, role: 'user' },
        order: { timestamp: 'ASC' },
      })
    ).map((e) => e.payload);

  describe('rows', () => {
    let row: Row;

    it('adds a record, and refuses a second with the same key', async () => {
      const res = await alice()
        .post('/tables/orders/rows')
        .send({ data: { order_id: 'A1', qty: 1 } })
        .expect(201);
      row = res.body as Row;
      expect(row).toMatchObject({ version: 1, data: { order_id: 'A1' } });
      const clash = await alice()
        .post('/tables/orders/rows')
        .send({ data: { order_id: 'A1', qty: 5 } })
        .expect(409);
      expect(clash.body).toMatchObject({ recordId: row.id, code: 'conflict' });
    });

    it('lists the table with its count and reads its rows', async () => {
      const list = await alice().get('/tables').expect(200);
      expect(list.body).toEqual([
        expect.objectContaining({ name: 'orders', records: 1 }),
      ]);
      const table = await alice().get('/tables/orders').expect(200);
      expect(table.body).toMatchObject({
        total: 1,
        truncated: false,
        definition: { primaryKey: ['order_id'] },
        rows: [{ id: row.id }],
      });
    });

    it('edits against a version, refusing a stale one and a bad value', async () => {
      const edited = await alice()
        .patch(`/tables/orders/rows/${row.id}`)
        .send({ changes: { qty: 3 }, version: 1 })
        .expect(200);
      expect(edited.body).toMatchObject({ version: 2, data: { qty: 3 } });
      const stale = await alice()
        .patch(`/tables/orders/rows/${row.id}`)
        .send({ changes: { qty: 4 }, version: 1 })
        .expect(409);
      expect(stale.body).toMatchObject({ code: 'stale' });
      await alice()
        .patch(`/tables/orders/rows/${row.id}`)
        .send({ changes: { qty: 0 }, version: 2 })
        .expect(400);
    });

    it('deletes against a version', async () => {
      await alice()
        .delete(`/tables/orders/rows/${row.id}?version=1`)
        .expect(409);
      await alice()
        .delete(`/tables/orders/rows/${row.id}?version=2`)
        .expect(204);
      await alice()
        .get('/tables/orders')
        .expect(200, /"total":0/);
    });

    it('audited each change as the user, with before and after', async () => {
      expect(await userChanges()).toEqual([
        expect.objectContaining({
          source: 'records',
          action: 'add_row',
          userId: 'alice',
        }),
        expect.objectContaining({
          action: 'update',
          before: { order_id: 'A1', qty: 1 },
          after: { order_id: 'A1', qty: 3 },
        }),
        expect.objectContaining({ action: 'delete_row' }),
      ]);
    });
  });

  describe('CSV', () => {
    it('appends every row, skipping held keys', async () => {
      await alice()
        .post('/tables/orders/csv')
        .attach(
          'file',
          Buffer.from('order_id,qty\nB1,1\nB2,2\nB1,9\n'),
          'o.csv',
        )
        .expect(201, { inserted: 2, alreadyExists: 1 });
    });

    it('adds nothing when a row is bad, naming its spreadsheet row', async () => {
      const res = await alice()
        .post('/tables/orders/csv')
        .attach('file', Buffer.from('order_id,qty\nC1,1\nC2,0\n'), 'o.csv')
        .expect(400);
      expect(res.body).toMatchObject({ errors: [{ row: 3 }] });
      await alice()
        .get('/tables')
        .expect(200, /"records":2/);
    });

    it('refuses a file over 5 MB', () =>
      alice()
        .post('/tables/orders/csv')
        .attach('file', Buffer.alloc(5 * 1024 * 1024 + 1, 'a'), 'big.csv')
        .expect(413));

    it('downloads a table as CSV, formula text guarded', async () => {
      await records.insert(companyId, 'orders', {
        order_id: 'B3',
        qty: 1,
        note: '=HYPERLINK("x")',
      });
      const res = await alice().get('/tables/orders/csv').expect(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toMatch(
        /^attachment; filename="\d{4}-\d\d-\d\d \d\d-\d\d-\d\d records-\d+ orders\.csv"$/,
      );
      expect(res.text).toBe(
        BOM + 'order_id,note,qty\nB1,,1\nB2,,2\nB3,"\'=HYPERLINK(""x"")",1\n',
      );
    });

    it('downloads every table as a zip', async () => {
      const res = await alice()
        .get('/export')
        .responseType('blob')
        .expect(200)
        .expect('Content-Type', 'application/zip');
      const files = unzipSync(new Uint8Array(res.body as Buffer));
      expect(Object.keys(files)).toEqual(['orders.csv']);
      expect(strFromU8(files['orders.csv'])).toContain('B2,,2');
    });
  });

  describe('clear and delete', () => {
    it('clears the records but keeps the table', async () => {
      await alice().delete('/tables/orders/rows').expect(200, { removed: 3 });
      await alice()
        .get('/tables')
        .expect(200, /"records":0/);
    });

    it('deletes the table, which is then gone', async () => {
      await alice().delete('/tables/orders').expect(200, { removed: 0 });
      await alice().get('/tables/orders').expect(404);
    });

    it('audited both, with the deleted definition', async () => {
      const changes = await userChanges();
      expect(changes.slice(-2)).toMatchObject([
        { action: 'clear_table', removed: 3 },
        { action: 'drop_table', definition: { name: 'orders' } },
      ]);
    });
  });

  describe('create table', () => {
    it('makes a table from a schema, refusing a bad one and a taken name', async () => {
      const table = { ...ORDERS, name: 'stock', primaryKey: ['order_id'] };
      const res = await alice().post('/tables').send(table).expect(201);
      expect(res.body).toMatchObject({
        name: 'stock',
        primaryKey: ['order_id'],
      });
      await alice().post('/tables').send(table).expect(409);
      await alice()
        .post('/tables')
        .send({ ...table, name: 'Bad Name' })
        .expect(400);
      expect((await userChanges()).at(-1)).toMatchObject({
        action: 'create_table',
        table: 'stock',
      });
    });
  });

  describe('data protection (001.04)', () => {
    const CUSTOMERS: NewTable = {
      name: 'customers',
      purpose: 'People who order.',
      schema: {
        type: 'object',
        properties: {
          email: { type: 'string' },
          name: { type: 'string' },
          delivered_on: { type: 'string', format: 'date' },
        },
        required: ['email'],
      },
      primaryKey: ['email'],
    };
    let entryId: string;

    beforeAll(async () => {
      await records.createTable(companyId, CUSTOMERS, null);
      await records.insert(companyId, 'customers', {
        email: 'cara@example.com',
        name: 'Cara Diaz',
      });
      await records.insert(companyId, 'customers', {
        email: 'dan@example.com',
        name: 'Dan Ito',
      });
    });

    it('keeps a do-not-store list: add, list, edit, refuse a duplicate', async () => {
      const added = await alice()
        .post('/do-not-store')
        .send({ value: 'Ann Lee', note: 'Asked by phone' })
        .expect(201);
      entryId = (added.body as { id: string }).id;
      expect(added.body).toMatchObject({
        value: 'Ann Lee',
        addedByRole: 'user',
        addedById: 'alice',
      });
      await alice()
        .post('/do-not-store')
        .send({ value: 'ann  LEE' })
        .expect(409);
      await alice()
        .patch(`/do-not-store/${entryId}`)
        .send({ note: null })
        .expect(200);
      const list = await alice().get('/do-not-store').expect(200);
      expect(list.body).toEqual([
        expect.objectContaining({ id: entryId, note: null }),
      ]);
    });

    it('warns before a person stores a match, and stores it once they confirm', async () => {
      const refused = await alice()
        .post('/tables/customers/rows')
        .send({ data: { email: 'ann@example.com', name: 'Mrs Ann Lee' } })
        .expect(409);
      expect(refused.body).toMatchObject({
        code: 'do_not_store',
        fields: ['name'],
      });
      await alice()
        .post('/tables/customers/rows?confirmDoNotStore=true')
        .send({ data: { email: 'ann@example.com', name: 'Mrs Ann Lee' } })
        .expect(201);
      await alice()
        .post('/tables/customers/csv')
        .attach(
          'file',
          Buffer.from('email,name\nx@example.com,ann lee\n'),
          'c.csv',
        )
        .expect(409);
    });

    it('finds a person in every table, and exports them', async () => {
      const found = await alice()
        .post('/search')
        .send({ q: 'ann' })
        .expect(200);
      const result = found.body as {
        groups: { definition: { name: string }; rows: Row[] }[];
      };
      expect(result.groups.map((g) => g.definition.name)).toEqual([
        'customers',
      ]);
      const ids = result.groups[0].rows.map((r) => r.id);

      const csv = await alice()
        .post('/export')
        .send({ tables: { customers: ids } })
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200)
        .expect('Content-Type', /text\/csv/);
      const text = (csv.body as Buffer).toString('utf8');
      expect(text).toContain('ann@example.com');
      expect(text).not.toContain('dan@example.com');

      await alice()
        .post('/export')
        .send({ tables: { customers: ids, stock: 'all' } })
        .expect(200)
        .expect('Content-Type', /application\/zip/);
    });

    it('deletes chosen rows together, refusing a stale version', async () => {
      const { rows } = (await alice().get('/tables/customers').expect(200))
        .body as { rows: Row[] };
      const cara = rows.find((r) => r.data.email === 'cara@example.com')!;
      const dan = rows.find((r) => r.data.email === 'dan@example.com')!;
      await alice()
        .post('/tables/customers/rows/delete')
        .send({
          rows: [
            { id: cara.id, version: cara.version },
            { id: dan.id, version: dan.version + 1 },
          ],
        })
        .expect(409);
      const removed = await alice()
        .post('/tables/customers/rows/delete')
        .send({ rows: [{ id: cara.id, version: cara.version }] })
        .expect(200);
      expect(removed.body).toEqual({ removed: 1 });
    });

    it('sets retention from a date field, refusing a field that is not a date', async () => {
      await alice()
        .put('/tables/customers/retention')
        .send({ retention: { days: 180, from: 'name' } })
        .expect(400);
      const set = await alice()
        .put('/tables/customers/retention')
        .send({ retention: { days: 180, from: 'delivered_on' } })
        .expect(200);
      expect(set.body).toMatchObject({
        retention: { days: 180, from: 'delivered_on' },
      });
      const cleared = await alice()
        .put('/tables/customers/retention')
        .send({ retention: null })
        .expect(200);
      expect(cleared.body).toMatchObject({ retention: null });
    });

    it('removes an entry, and audited everything without names or values', async () => {
      await alice().delete(`/do-not-store/${entryId}`).expect(204);
      await alice().delete(`/do-not-store/${entryId}`).expect(404);
      const changes = await userChanges();
      const actions = changes.map((c) => c.action);
      for (const action of [
        'do_not_store_add',
        'do_not_store_update',
        'delete_rows',
        'set_retention',
        'do_not_store_remove',
      ]) {
        expect(actions).toContain(action);
      }
      const dataProtection = changes.filter((c) =>
        String(c.action).match(/do_not_store|delete_rows|set_retention/),
      );
      expect(JSON.stringify(dataProtection)).not.toMatch(/Ann Lee|Cara Diaz/);
      expect(
        changes.find((c) => c.doNotStoreOverride !== undefined),
      ).toMatchObject({ action: 'add_row', doNotStoreOverride: ['name'] });
    });
  });

  // Every route, as someone who isn't a member: refused before anything runs.
  it.each([
    ['get', '/tables'],
    ['get', '/export'],
    ['get', '/tables/orders'],
    ['get', '/tables/orders/csv'],
    ['post', '/tables/orders/csv'],
    ['post', '/tables/orders/rows'],
    ['patch', '/tables/orders/rows/x'],
    ['delete', '/tables/orders/rows/x?version=1'],
    ['delete', '/tables/orders/rows'],
    ['delete', '/tables/orders'],
    ['post', '/tables'],
    ['post', '/search'],
    ['post', '/export'],
    ['post', '/tables/orders/rows/delete'],
    ['put', '/tables/orders/retention'],
    ['get', '/do-not-store'],
    ['post', '/do-not-store'],
    ['patch', '/do-not-store/x'],
    ['delete', '/do-not-store/x'],
  ] as const)('refuses %s %s to a non-member', (method, path) =>
    as(bobJwt)[method](path).expect(403),
  );
});
