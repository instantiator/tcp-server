import {
  RecordsError,
  RecordsService,
  type TableDefinition,
  type TcpCompany,
} from '@tcp/shared';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { AuditService } from '../audit/audit.service';
import { DbService } from '../db/db.service';
import { RecordsApiService } from './records-api.service';

const DEFINITION: TableDefinition = {
  id: 't1',
  name: 'orders',
  purpose: 'Orders',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { order_id: { type: 'string' }, qty: { type: 'integer' } },
    required: ['order_id'],
  },
  primaryKey: ['order_id'],
  uniqueKeys: [],
  retention: null,
};

const TIMED = {
  id: 'r1',
  data: { order_id: 'A1', qty: 2 },
  version: 2,
  createdAt: '2026-10-11T10:00:00.000Z',
  updatedAt: '2026-10-11T11:00:00.000Z',
};

describe('RecordsApiService', () => {
  const company = { id: randomUUID(), slug: 'acme' } as const;
  const records = {
    createTable: jest.fn(),
    listTableSummaries: jest.fn(),
    describeTable: jest.fn(),
    readRows: jest.fn(),
    readRow: jest.fn(),
    insert: jest.fn(),
    insertMany: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    clearTable: jest.fn(),
    dropTable: jest.fn(),
    forEachRowBatch: jest.fn(),
  };
  const audit = {
    record: jest.fn<
      ReturnType<AuditService['record']>,
      Parameters<AuditService['record']>
    >(),
  };
  const db = { getCompany: jest.fn() };
  let service: RecordsApiService;
  let acme: TcpCompany;

  beforeEach(async () => {
    jest.resetAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        RecordsApiService,
        { provide: RecordsService, useValue: records },
        { provide: AuditService, useValue: audit },
        { provide: DbService, useValue: db },
      ],
    }).compile();
    service = module.get(RecordsApiService);
    db.getCompany.mockResolvedValue(company);
    acme = await service.company('acme');
    records.describeTable.mockResolvedValue(DEFINITION);
    records.readRow.mockResolvedValue(TIMED);
  });

  /** The payload of the one audit record written. */
  function audited(): unknown {
    expect(audit.record).toHaveBeenCalledTimes(1);
    const [companyId, role, agentId, eventType, payload] =
      audit.record.mock.calls[0];
    expect([companyId, role, agentId, eventType]).toEqual([
      company.id,
      'user',
      null,
      'state_change',
    ]);
    return payload;
  }

  it('makes a table for the company and audits its definition', async () => {
    records.createTable.mockResolvedValue(DEFINITION);
    const table = {
      name: 'orders',
      purpose: 'Orders',
      schema: { properties: {} },
      primaryKey: ['order_id'],
    };
    await expect(service.createTable(acme, table, 'u')).resolves.toBe(
      DEFINITION,
    );
    expect(records.createTable).toHaveBeenCalledWith(company.id, table, null);
    expect(audited()).toMatchObject({
      action: 'create_table',
      table: 'orders',
      definition: DEFINITION,
      userId: 'u',
    });
  });

  it('answers an unknown company with 404', async () => {
    db.getCompany.mockResolvedValue(null);
    await expect(service.company('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('audits an edit with before and after, and returns the row with timestamps', async () => {
    records.update.mockResolvedValue({
      record: { id: 'r1', data: TIMED.data, version: 2 },
      before: { order_id: 'A1', qty: 1 },
    });
    await expect(
      service.updateRow(acme, 'orders', 'r1', { qty: 2 }, 1, 'user-1'),
    ).resolves.toEqual(TIMED);
    expect(records.update).toHaveBeenCalledWith(
      company.id,
      'orders',
      { id: 'r1' },
      { qty: 2 },
      1,
    );
    expect(audited()).toEqual({
      source: 'records',
      action: 'update',
      table: 'orders',
      recordId: 'r1',
      before: { order_id: 'A1', qty: 1 },
      after: TIMED.data,
      userId: 'user-1',
    });
  });

  it.each([
    ['not_found', NotFoundException],
    ['stale', ConflictException],
    ['conflict', ConflictException],
    ['invalid', BadRequestException],
  ] as const)(
    'turns a %s records error into %p, and audits nothing',
    async (code, type) => {
      records.update.mockRejectedValue(new RecordsError('no', code));
      await expect(
        service.updateRow(acme, 'orders', 'r1', {}, 1, null),
      ).rejects.toBeInstanceOf(type);
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('refuses to add a record whose key is held, naming the holder', async () => {
    records.insert.mockResolvedValue({
      status: 'already_exists',
      record: { id: 'r9', data: {}, version: 1 },
      key: { order_id: 'A1' },
      matches: false,
    });
    const failure = service.addRow(acme, 'orders', { order_id: 'A1' }, null);
    await expect(failure).rejects.toBeInstanceOf(ConflictException);
    await expect(failure).rejects.toMatchObject({
      response: { recordId: 'r9', code: 'conflict' },
    });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('audits added and deleted rows', async () => {
    records.insert.mockResolvedValue({
      status: 'inserted',
      record: { id: 'r1', data: TIMED.data, version: 1 },
    });
    await service.addRow(acme, 'orders', TIMED.data, 'u');
    expect(audited()).toMatchObject({ action: 'add_row', after: TIMED.data });
    audit.record.mockReset();
    records.delete.mockResolvedValue({ record: TIMED, before: TIMED.data });
    await service.deleteRow(acme, 'orders', 'r1', 2, 'u');
    expect(records.delete).toHaveBeenCalledWith(
      company.id,
      'orders',
      { id: 'r1' },
      2,
    );
    expect(audited()).toMatchObject({
      action: 'delete_row',
      before: TIMED.data,
    });
  });

  describe('appendCsv', () => {
    it('adds the rows and audits the counts, not the data', async () => {
      records.insertMany.mockResolvedValue({
        inserted: 1,
        alreadyExists: 1,
        errors: [],
      });
      await expect(
        service.appendCsv(
          acme,
          'orders',
          Buffer.from('order_id,qty\nA1,1\nA2,2\n'),
          'u',
        ),
      ).resolves.toEqual({ inserted: 1, alreadyExists: 1 });
      expect(records.insertMany).toHaveBeenCalledWith(company.id, 'orders', [
        { order_id: 'A1', qty: 1 },
        { order_id: 'A2', qty: 2 },
      ]);
      expect(audited()).toEqual({
        source: 'records',
        action: 'append_csv',
        table: 'orders',
        inserted: 1,
        alreadyExists: 1,
        userId: 'u',
      });
    });

    it('reports cells of the wrong type by spreadsheet row, without inserting', async () => {
      const failure = service.appendCsv(
        acme,
        'orders',
        Buffer.from('order_id,qty\nA1,1\nA2,lots\n'),
        null,
      );
      await expect(failure).rejects.toMatchObject({
        response: {
          errors: [{ row: 3 }],
        },
      });
      expect(records.insertMany).not.toHaveBeenCalled();
    });

    it('turns schema failures into spreadsheet rows (the header is row 1)', async () => {
      records.insertMany.mockResolvedValue({
        inserted: 0,
        alreadyExists: 0,
        errors: [{ row: 1, message: 'order_id is required' }],
      });
      await expect(
        service.appendCsv(acme, 'orders', Buffer.from('qty\n1\n'), null),
      ).rejects.toMatchObject({
        response: { errors: [{ row: 2, message: 'order_id is required' }] },
      });
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  it('audits a clear by count and a drop with the definition', async () => {
    records.clearTable.mockResolvedValue(4);
    await expect(service.clearTable(acme, 'orders', 'u')).resolves.toEqual({
      removed: 4,
    });
    expect(audited()).toMatchObject({ action: 'clear_table', removed: 4 });
    audit.record.mockReset();
    records.dropTable.mockResolvedValue({ definition: DEFINITION, removed: 2 });
    await service.dropTable(acme, 'orders', 'u');
    expect(audited()).toMatchObject({
      action: 'drop_table',
      removed: 2,
      definition: DEFINITION,
    });
  });

  describe('exports', () => {
    beforeEach(() => {
      records.forEachRowBatch.mockImplementation(
        async (
          _c: string,
          _t: string,
          onBatch: (rows: Record<string, unknown>[]) => Promise<void>,
        ) => {
          await onBatch([{ order_id: 'A1', qty: 1 }]);
          await onBatch([{ order_id: 'A2', qty: 2 }]);
        },
      );
    });

    it('writes one table as CSV with a BOM, the header once and every batch', async () => {
      const csv = await service.tableCsv(acme, 'orders');
      expect(csv.filename).toMatch(
        /^\d{4}-\d\d-\d\d \d\d-\d\d-\d\d acme orders\.csv$/,
      );
      // Buffer, not strFromU8: TextDecoder drops a leading BOM.
      expect(Buffer.from(csv.body).toString('utf8')).toBe(
        '\uFEFForder_id,qty\nA1,1\nA2,2\n',
      );
    });

    it('zips every table, one CSV each', async () => {
      records.listTableSummaries.mockResolvedValue([
        { name: 'orders', purpose: '', records: 2, updatedAt: '' },
        { name: 'stock', purpose: '', records: 2, updatedAt: '' },
      ]);
      const zip = await service.exportZip(acme);
      expect(zip.filename).toMatch(/ acme tables\.zip$/);
      const files = unzipSync(zip.body);
      expect(Object.keys(files)).toEqual(['orders.csv', 'stock.csv']);
      expect(strFromU8(files['stock.csv'])).toContain('A2,2');
    });
  });
});
