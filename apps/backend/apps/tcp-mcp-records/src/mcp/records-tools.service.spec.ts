import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  AuditClientService,
  AuditEventType,
  RecordsError,
  RecordsService,
} from '@tcp/shared';
import { randomUUID } from 'crypto';
import { RecordsToolsService } from './records-tools.service';

const companyId = randomUUID();
const agentId = randomUUID();
const stored = {
  id: randomUUID(),
  data: { order_id: 'A1', qty: 2 },
  version: 1,
};

function makeRecords(): jest.Mocked<RecordsService> {
  return {
    listTables: jest.fn().mockResolvedValue([]),
    describeTable: jest.fn(),
    createTable: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    query: jest.fn(),
    aggregate: jest.fn(),
    deleteCompany: jest.fn(),
  } as unknown as jest.Mocked<RecordsService>;
}

function makeAudit(): jest.Mocked<AuditClientService> {
  return { record: jest.fn() } as unknown as jest.Mocked<AuditClientService>;
}

/** Calls a tool through a real MCP client, so the input schemas are exercised too. */
async function callTool(
  service: RecordsToolsService,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const server = service.createServer();
  const client = new Client({ name: 'spec', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const result = CallToolResultSchema.parse(
      await client.callTool({
        name,
        arguments: { companyId, agentId, ...args },
      }),
    );
    const first = result.content[0];
    return {
      text: first?.type === 'text' ? first.text : '',
      isError: result.isError === true,
    };
  } finally {
    await client.close();
  }
}

describe('RecordsToolsService', () => {
  let records: jest.Mocked<RecordsService>;
  let audit: jest.Mocked<AuditClientService>;
  let service: RecordsToolsService;

  beforeEach(() => {
    records = makeRecords();
    audit = makeAudit();
    service = new RecordsToolsService(records, audit);
  });

  it('list_tables says how to start when there are none', async () => {
    const { text } = await callTool(service, 'list_tables', {});
    expect(text).toMatch(/create_table/);
    expect(records.listTables).toHaveBeenCalledWith(companyId);
  });

  it('insert passes the whole free-form record through, and audits the new values', async () => {
    records.insert.mockResolvedValue({ status: 'inserted', record: stored });
    const { text } = await callTool(service, 'insert', {
      table: 'orders',
      record: stored.data,
    });
    expect(records.insert).toHaveBeenCalledWith(
      companyId,
      'orders',
      stored.data,
    );
    expect(JSON.parse(text)).toMatchObject({ status: 'inserted' });
    expect(audit.record).toHaveBeenCalledWith(
      companyId,
      'agent',
      agentId,
      AuditEventType.StateChange,
      {
        source: 'records',
        action: 'insert',
        table: 'orders',
        recordId: stored.id,
        before: null,
        after: stored.data,
      },
    );
  });

  it('insert of an existing key explains itself and audits a read, not a change', async () => {
    records.insert.mockResolvedValue({
      status: 'already_exists',
      record: stored,
      key: { order_id: 'A1' },
      matches: true,
    });
    const { text } = await callTool(service, 'insert', {
      table: 'orders',
      record: stored.data,
    });
    expect(JSON.parse(text)).toMatchObject({
      status: 'already_exists',
      note: expect.stringContaining('{"order_id":"A1"}') as unknown,
    });
    expect(audit.record).toHaveBeenCalledWith(
      companyId,
      'agent',
      agentId,
      AuditEventType.ToolCall,
      expect.objectContaining({
        outcome: 'already_exists',
        recordIds: [stored.id],
      }),
    );
  });

  it('update finds the record by key and audits before and after', async () => {
    const after = { ...stored, data: { order_id: 'A1', qty: 3 }, version: 2 };
    records.update.mockResolvedValue({ record: after, before: stored.data });
    await callTool(service, 'update', {
      table: 'orders',
      key: { order_id: 'A1' },
      changes: { qty: 3 },
    });
    expect(records.update).toHaveBeenCalledWith(
      companyId,
      'orders',
      { key: { order_id: 'A1' } },
      { qty: 3 },
    );
    expect(audit.record).toHaveBeenCalledWith(
      companyId,
      'agent',
      agentId,
      AuditEventType.StateChange,
      expect.objectContaining({
        action: 'update',
        before: stored.data,
        after: after.data,
      }),
    );
  });

  it('delete by id audits the record it removed', async () => {
    records.delete.mockResolvedValue({ record: stored, before: stored.data });
    const { text } = await callTool(service, 'delete', {
      table: 'orders',
      id: stored.id,
    });
    expect(records.delete).toHaveBeenCalledWith(companyId, 'orders', {
      id: stored.id,
    });
    expect(JSON.parse(text)).toEqual({ deleted: stored.id });
    expect(audit.record).toHaveBeenCalledWith(
      companyId,
      'agent',
      agentId,
      AuditEventType.StateChange,
      expect.objectContaining({
        action: 'delete',
        before: stored.data,
        after: null,
      }),
    );
  });

  it('update with neither id nor key is a correctable error and audits nothing', async () => {
    const { text } = await callTool(service, 'update', {
      table: 'orders',
      changes: { qty: 3 },
    });
    expect(text).toMatch(/^Error: .*id.*key/);
    expect(records.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('query audits the ids it returned', async () => {
    records.query.mockResolvedValue({ records: [stored], total: 1 });
    const filters = [{ field: 'qty', op: 'gt', value: 1 }];
    await callTool(service, 'query', { table: 'orders', filters });
    expect(audit.record).toHaveBeenCalledWith(
      companyId,
      'agent',
      agentId,
      AuditEventType.ToolCall,
      {
        source: 'records',
        tool: 'query',
        table: 'orders',
        filters,
        recordIds: [stored.id],
      },
    );
  });

  it('aggregate passes group_by through and audits the read', async () => {
    records.aggregate.mockResolvedValue([{ group: {}, value: '0.3' }]);
    const { text } = await callTool(service, 'aggregate', {
      table: 'orders',
      op: 'sum',
      field: 'total',
      group_by: ['customer'],
    });
    expect(records.aggregate).toHaveBeenCalledWith(companyId, 'orders', {
      op: 'sum',
      field: 'total',
      groupBy: ['customer'],
      filters: undefined,
    });
    expect(JSON.parse(text)).toEqual([{ group: {}, value: '0.3' }]);
    expect(audit.record).toHaveBeenCalledWith(
      companyId,
      'agent',
      agentId,
      AuditEventType.ToolCall,
      expect.objectContaining({ tool: 'aggregate', groups: 1 }),
    );
  });

  it('create_table maps the snake_case arguments and audits the definition', async () => {
    const definition = {
      id: randomUUID(),
      name: 'orders',
      purpose: 'Orders',
      schema: {
        type: 'object' as const,
        properties: {},
        additionalProperties: false as const,
      },
      primaryKey: ['order_id'],
      uniqueKeys: [],
      retention: null,
    };
    records.createTable.mockResolvedValue(definition);
    await callTool(service, 'create_table', {
      name: 'orders',
      purpose: 'Orders',
      schema: { type: 'object', properties: { order_id: { type: 'string' } } },
      primary_key: ['order_id'],
    });
    expect(records.createTable).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        primaryKey: ['order_id'],
        uniqueKeys: undefined,
      }),
      agentId,
    );
    expect(audit.record).toHaveBeenCalledWith(
      companyId,
      'agent',
      agentId,
      AuditEventType.StateChange,
      expect.objectContaining({ action: 'create_table', definition }),
    );
  });

  it('a records error goes back as a correctable error, with no audit', async () => {
    records.query.mockRejectedValue(
      new RecordsError("there is no table named 'x'"),
    );
    const { text } = await callTool(service, 'query', { table: 'x' });
    expect(text).toBe("Error: there is no table named 'x'");
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects an unknown filter op before reaching the service', async () => {
    const { isError } = await callTool(service, 'query', {
      table: 'orders',
      filters: [{ field: 'qty', op: 'like', value: 1 }],
    });
    expect(isError).toBe(true);
    expect(records.query).not.toHaveBeenCalled();
  });
});
