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
  ] as const)('refuses %s %s to a non-member', (method, path) =>
    as(bobJwt)[method](path).expect(403),
  );
});
