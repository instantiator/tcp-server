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
    doNotStoreMatches: jest.fn().mockResolvedValue([]),
    addDoNotStore: jest.fn(),
    alterTable: jest.fn(),
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

  describe('the do-not-store list', () => {
    it('refuses an insert that matches, stores nothing, and audits field names only', async () => {
      records.doNotStoreMatches.mockResolvedValue(['customer']);

      const { text, isError } = await callTool(service, 'insert', {
        table: 'orders',
        record: { order_id: 'A1', customer: 'Ann Lee' },
      });

      expect(isError).toBe(false);
      expect(JSON.parse(text)).toMatchObject({
        status: 'not_stored',
        fields: ['customer'],
      });
      expect(text).toContain('fail_assignment');
      expect(records.insert).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        companyId,
        'agent',
        agentId,
        AuditEventType.ToolCall,
        {
          source: 'records',
          tool: 'insert',
          table: 'orders',
          outcome: 'do_not_store',
          fields: ['customer'],
        },
      );
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain('Ann Lee');
    });

    it('refuses an update whose changes match, and changes nothing', async () => {
      records.doNotStoreMatches.mockResolvedValue(['email']);

      const { text } = await callTool(service, 'update', {
        table: 'orders',
        id: stored.id,
        changes: { email: 'ann@example.com' },
      });

      expect(records.doNotStoreMatches).toHaveBeenCalledWith(companyId, [
        { email: 'ann@example.com' },
      ]);
      expect(text).toContain('not_stored');
      expect(records.update).not.toHaveBeenCalled();
    });

    it('adds an entry, auditing its id but not its text', async () => {
      records.addDoNotStore.mockResolvedValue({
        id: 'entry-1',
        value: 'Ann Lee',
        note: 'Asked in chat',
        addedByRole: 'agent',
        addedById: agentId,
        createdAt: '',
        updatedAt: '',
      });

      const { text } = await callTool(service, 'do_not_store', {
        action: 'add',
        value: 'Ann Lee',
        reason: 'Asked in chat',
      });

      expect(text).toMatch(/^Added/);
      expect(records.addDoNotStore).toHaveBeenCalledWith(
        companyId,
        { value: 'Ann Lee', note: 'Asked in chat' },
        { role: 'agent', id: agentId },
      );
      expect(JSON.stringify(audit.record.mock.calls)).toContain('entry-1');
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain('Ann Lee');
    });

    it('treats an entry already on the list as done', async () => {
      records.addDoNotStore.mockRejectedValue(
        new RecordsError('already there', 'conflict'),
      );

      const { text, isError } = await callTool(service, 'do_not_store', {
        action: 'add',
        value: 'Ann Lee',
        reason: 'Asked again',
      });

      expect(isError).toBe(false);
      expect(text).toMatch(/already on the do-not-store list/);
    });

    it.each([
      ['remove', 'removed'],
      ['change', 'changed'],
    ])(
      'does nothing for %s, and advises asking a user',
      async (action, word) => {
        const { text } = await callTool(service, 'do_not_store', {
          action,
          value: 'Ann Lee',
          reason: 'Customer withdrew the request',
        });

        expect(text).toContain(`can only be ${word} by a person`);
        expect(text).toContain('request_user_input');
        expect(records.addDoNotStore).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalled();
      },
    );
  });

  describe('alter_table', () => {
    /** A feedings table keyed on date and time, before and after a column change. */
    const tableId = randomUUID();
    const feedings = (extra: object = {}) => ({
      id: tableId,
      name: 'feedings',
      purpose: 'When the animals were fed',
      schema: {
        type: 'object' as const,
        properties: {
          feeding_date: { type: 'string' as const },
          feeding_time: { type: 'string' as const },
        },
        required: ['feeding_date', 'feeding_time'],
        additionalProperties: false as const,
      },
      primaryKey: ['feeding_date', 'feeding_time'],
      uniqueKeys: [],
      retention: null,
      ...extra,
    });

    it('adds a column with a default, and audits both definitions but not the default', async () => {
      const after = feedings({ purpose: 'changed' });
      records.alterTable.mockResolvedValue({
        definition: after,
        before: feedings(),
        rewritten: 2,
        blanked: 0,
      });
      const { text } = await callTool(service, 'alter_table', {
        table: 'feedings',
        action: 'add_column',
        column: 'animal',
        type: 'string',
        default: 'chicken',
      });
      expect(text).not.toMatch(/^Error/);
      expect(records.alterTable).toHaveBeenCalledWith(
        companyId,
        'feedings',
        {
          op: 'add_column',
          column: 'animal',
          type: 'string',
          format: undefined,
          description: undefined,
          default: 'chicken',
          required: undefined,
        },
        { byPerson: false },
      );
      expect(JSON.parse(text)).toEqual({ table: after, rewritten: 2 });
      expect(audit.record).toHaveBeenCalledWith(
        companyId,
        'agent',
        agentId,
        AuditEventType.StateChange,
        {
          source: 'records',
          action: 'alter_table',
          op: 'add_column',
          table: 'feedings',
          before: feedings(),
          after,
          rewritten: 2,
        },
      );
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain('chicken');
    });

    it('maps rename and set-key arguments to their changes', async () => {
      records.alterTable.mockResolvedValue({
        definition: feedings(),
        before: feedings(),
        rewritten: 0,
        blanked: 0,
      });
      await callTool(service, 'alter_table', {
        table: 'feedings',
        action: 'rename_column',
        column: 'feeding_date',
        new_name: 'fed_on',
      });
      await callTool(service, 'alter_table', {
        table: 'feedings',
        action: 'set_primary_key',
        fields: ['feeding_date', 'feeding_time', 'animal'],
      });
      expect(records.alterTable.mock.calls.map((c) => c[2])).toEqual([
        { op: 'rename_column', column: 'feeding_date', newName: 'fed_on' },
        {
          op: 'set_primary_key',
          fields: ['feeding_date', 'feeding_time', 'animal'],
        },
      ]);
    });

    it('says which argument an action is missing, and changes nothing', async () => {
      const { text } = await callTool(service, 'alter_table', {
        table: 'feedings',
        action: 'rename_column',
        column: 'feeding_date',
      });
      expect(text).toMatch(/^Error: rename_column needs `new_name`/);
      expect(records.alterTable).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('deletes nothing: it advises asking a user, naming the column, with no audit', async () => {
      records.describeTable.mockResolvedValue({
        ...feedings(),
        schema: {
          ...feedings().schema,
          properties: {
            ...feedings().schema.properties,
            note: { type: 'string' as const },
          },
        },
      });
      const { text } = await callTool(service, 'alter_table', {
        table: 'feedings',
        action: 'delete_column',
        column: 'note',
      });
      expect(text).toMatch(/^Nothing was deleted/);
      expect(text).toMatch(/request_user_input/);
      expect(text).toContain("'note' from 'feedings'");
      expect(records.alterTable).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('refuses to advise deleting a key column, saying why', async () => {
      records.describeTable.mockResolvedValue(feedings());
      const { text } = await callTool(service, 'alter_table', {
        table: 'feedings',
        action: 'delete_column',
        column: 'feeding_time',
      });
      expect(text).toMatch(/^Error: .*take it out of the key first/);
    });

    it('passes a narrowing refusal back as a correctable error', async () => {
      records.alterTable.mockRejectedValue(
        new RecordsError(
          'taking feeding_time out of the key ... ask a user with request_user_input',
        ),
      );
      const { text } = await callTool(service, 'alter_table', {
        table: 'feedings',
        action: 'set_primary_key',
        fields: ['feeding_date'],
      });
      expect(text).toMatch(/^Error: .*request_user_input/);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it.each(['add_unique_key', 'drop_unique_key'])(
      '%s changes nothing: it advises asking a user, naming the fields, with no audit',
      async (action) => {
        const { text } = await callTool(service, 'alter_table', {
          table: 'feedings',
          action,
          fields: ['animal', 'feeding_date'],
        });
        expect(text).toMatch(/^Nothing was changed/);
        expect(text).toContain("animal, feeding_date on 'feedings'");
        expect(text).toMatch(/request_user_input/);
        expect(records.alterTable).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalled();
      },
    );

    it('retypes a column as an agent, passing a refusal back as a correctable error', async () => {
      records.alterTable.mockResolvedValueOnce({
        definition: feedings(),
        before: feedings(),
        rewritten: 2,
        blanked: 0,
      });
      await callTool(service, 'alter_table', {
        table: 'feedings',
        action: 'retype_column',
        column: 'portion',
        type: 'integer',
      });
      expect(records.alterTable).toHaveBeenCalledWith(
        companyId,
        'feedings',
        {
          op: 'retype_column',
          column: 'portion',
          type: 'integer',
          format: undefined,
        },
        { byPerson: false },
      );

      records.alterTable.mockRejectedValueOnce(
        new RecordsError(
          "1 value doesn't convert ... ask a user with request_user_input",
          'unconvertible',
        ),
      );
      const { text } = await callTool(service, 'alter_table', {
        table: 'feedings',
        action: 'retype_column',
        column: 'portion',
        type: 'integer',
      });
      expect(text).toMatch(
        /^Error: 1 value doesn't convert.*request_user_input/,
      );
    });

    it('refuses a default on the do-not-store list, auditing the field name only', async () => {
      records.doNotStoreMatches.mockResolvedValue(['keeper']);
      const { text } = await callTool(service, 'alter_table', {
        table: 'feedings',
        action: 'add_column',
        column: 'keeper',
        type: 'string',
        default: 'Jane Doe',
      });
      expect(JSON.parse(text)).toMatchObject({ status: 'not_stored' });
      expect(records.alterTable).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        companyId,
        'agent',
        agentId,
        AuditEventType.ToolCall,
        {
          source: 'records',
          tool: 'alter_table',
          table: 'feedings',
          outcome: 'do_not_store',
          fields: ['keeper'],
        },
      );
    });
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
