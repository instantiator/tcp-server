import {
  AGGREGATE_OPS,
  AuditClientService,
  AuditEventType,
  FILTER_OPS,
  RecordsError,
  RecordsService,
  type RecordRef,
  TABLE_CHANGE_OPS,
  type TableChange,
  ToolResult,
  checkDelete,
  err,
  ok,
  registerDescribeServer,
} from '@tcp/shared';
import { Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { recordsPrompts } from '../records-prompts';
import { recordsToolDescriptions } from '../records-tool-descriptions';

/**
 * The audit trail's role column. The tools receive only an `agentId`, and the
 * records database may not hold `tcp_role`, so this uses the tasks server's
 * convention; tcp-server fills in the agent's task and assignment.
 */
const AUDIT_ROLE = 'agent';

/** Identity arguments the agent side injects on every call — never chosen by the model. */
const identity = {
  companyId: z.uuid().describe('The company the records belong to.'),
  agentId: z.uuid().describe('The agent making the call.'),
};

const tableArg = z.string().describe('Table name');
const freeForm = z.record(z.string(), z.unknown());
// Untyped on purpose: a union of value types costs tokens on every turn, and
// RecordSql checks each value against its field's declared type anyway.
const filtersArg = z
  .array(
    z.object({ field: z.string(), op: z.enum(FILTER_OPS), value: z.unknown() }),
  )
  .optional();
const refArgs = {
  id: z.string().optional(),
  key: freeForm.optional().describe('Primary key values'),
};

/** Picks the record reference out of a tool's `id`/`key` arguments. */
function recordRef(args: {
  id?: string;
  key?: Record<string, unknown>;
}): RecordRef {
  if (args.id) return { id: args.id };
  if (args.key) return { key: args.key };
  throw new RecordsError('give either the record `id` or its primary `key`');
}

/** The arguments `alter_table` takes, as the model sends them. */
interface AlterArgs {
  action: (typeof TABLE_CHANGE_OPS)[number];
  column?: string;
  new_name?: string;
  type?: 'string' | 'number' | 'integer' | 'boolean';
  format?: 'date';
  description?: string;
  default?: unknown;
  required?: boolean;
  fields?: string[];
}

/** Turns `alter_table`'s flat arguments into a {@link TableChange}, saying which one is missing. */
function tableChange(args: AlterArgs): TableChange {
  const need = <T>(value: T | undefined, name: string): T => {
    if (value === undefined) {
      throw new RecordsError(`${args.action} needs \`${name}\``);
    }
    return value;
  };
  switch (args.action) {
    case 'add_column':
      return {
        op: 'add_column',
        column: need(args.column, 'column'),
        type: need(args.type, 'type'),
        format: args.format,
        description: args.description,
        default: args.default,
        required: args.required,
      };
    case 'rename_column':
      return {
        op: 'rename_column',
        column: need(args.column, 'column'),
        newName: need(args.new_name, 'new_name'),
      };
    case 'delete_column':
      return { op: 'delete_column', column: need(args.column, 'column') };
    case 'set_primary_key':
      return { op: 'set_primary_key', fields: need(args.fields, 'fields') };
  }
}

/** Replaces `{{key}}` placeholders in a template string. */
function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(
    /\{\{(\w+)\}\}/g,
    (_, key: string) => vars[key] ?? '',
  );
}

/**
 * Builds fresh {@link McpServer} instances with the records tools, backed by
 * {@link RecordsService}. `companyId` and `agentId` are injected by the agent
 * side, so a model can only ever reach its own company's tables.
 *
 * Every read and change of a record is audited: changes as `state_change`
 * with the values before and after, reads as `tool_call` with the ids read.
 * A {@link RecordsError} goes back to the model as a correctable error and
 * audits nothing, since nothing was read or changed.
 */
@Injectable()
export class RecordsToolsService {
  constructor(
    private readonly records: RecordsService,
    private readonly audit: AuditClientService,
  ) {}

  /** Creates and returns a configured McpServer with all records tools registered. */
  createServer(): McpServer {
    const server = new McpServer({ name: 'tcp-mcp-records', version: '1.0.0' });
    const d = recordsToolDescriptions;
    registerDescribeServer(
      server,
      d.describe_server,
      recordsPrompts.describe_server,
    );

    server.registerTool(
      'list_tables',
      { description: d.list_tables, inputSchema: identity },
      ({ companyId }) =>
        this.run(async () => {
          const tables = await this.records.listTables(companyId);
          return tables.length ? tables : recordsPrompts.no_tables;
        }),
    );

    server.registerTool(
      'describe_table',
      {
        description: d.describe_table,
        inputSchema: { ...identity, table: tableArg },
      },
      ({ companyId, table }) =>
        this.run(() => this.records.describeTable(companyId, table)),
    );

    server.registerTool(
      'create_table',
      {
        description: d.create_table,
        inputSchema: {
          ...identity,
          name: z.string(),
          purpose: z.string().describe('What it holds, shown to all agents'),
          schema: freeForm,
          primary_key: z.array(z.string()),
          unique_keys: z
            .array(z.array(z.string()))
            .optional()
            .describe('Other unique field sets, e.g. [["email"]]'),
        },
      },
      (args) =>
        this.run(async () => {
          const table = await this.records.createTable(
            args.companyId,
            {
              name: args.name,
              purpose: args.purpose,
              schema: args.schema,
              primaryKey: args.primary_key,
              uniqueKeys: args.unique_keys,
            },
            args.agentId,
          );
          this.change(args.companyId, args.agentId, {
            action: 'create_table',
            table: table.name,
            definition: table,
          });
          return table;
        }),
    );

    server.registerTool(
      'insert',
      {
        description: d.insert,
        inputSchema: {
          ...identity,
          table: tableArg,
          record: freeForm,
        },
      },
      ({ companyId, agentId, table, record }) =>
        this.run(async () => {
          const refused = await this.refuseDoNotStore(
            companyId,
            agentId,
            'insert',
            table,
            record,
          );
          if (refused) return refused;
          const result = await this.records.insert(companyId, table, record);
          if (result.status === 'inserted') {
            this.change(companyId, agentId, {
              action: 'insert',
              table,
              recordId: result.record.id,
              before: null,
              after: result.record.data,
            });
            return result;
          }
          // Nothing was written, but an existing record was read back.
          this.read(companyId, agentId, {
            tool: 'insert',
            table,
            outcome: 'already_exists',
            recordIds: [result.record.id],
          });
          return {
            ...result,
            note: interpolate(recordsPrompts.already_exists, {
              key: JSON.stringify(result.key),
            }),
          };
        }),
    );

    server.registerTool(
      'update',
      {
        description: d.update,
        inputSchema: {
          ...identity,
          table: tableArg,
          ...refArgs,
          changes: freeForm,
        },
      },
      ({ companyId, agentId, table, changes, ...ref }) =>
        this.run(async () => {
          // Fields already stored were checked when they were written.
          const refused = await this.refuseDoNotStore(
            companyId,
            agentId,
            'update',
            table,
            changes,
          );
          if (refused) return refused;
          const { record, before } = await this.records.update(
            companyId,
            table,
            recordRef(ref),
            changes,
          );
          this.change(companyId, agentId, {
            action: 'update',
            table,
            recordId: record.id,
            before,
            after: record.data,
          });
          return record;
        }),
    );

    server.registerTool(
      'delete',
      {
        description: d.delete,
        inputSchema: { ...identity, table: tableArg, ...refArgs },
      },
      ({ companyId, agentId, table, ...ref }) =>
        this.run(async () => {
          const { record, before } = await this.records.delete(
            companyId,
            table,
            recordRef(ref),
          );
          this.change(companyId, agentId, {
            action: 'delete',
            table,
            recordId: record.id,
            before,
            after: null,
          });
          return { deleted: record.id };
        }),
    );

    server.registerTool(
      'query',
      {
        description: d.query,
        inputSchema: {
          ...identity,
          table: tableArg,
          filters: filtersArg,
          sort: z
            .array(
              z.object({
                field: z.string(),
                direction: z.enum(['asc', 'desc']).optional(),
              }),
            )
            .optional(),
          limit: z.number().int().optional().describe('Default 50, max 200'),
          offset: z.number().int().optional(),
        },
      },
      ({ companyId, agentId, table, ...query }) =>
        this.run(async () => {
          const result = await this.records.query(companyId, table, query);
          this.read(companyId, agentId, {
            tool: 'query',
            table,
            filters: query.filters ?? [],
            recordIds: result.records.map((r) => r.id),
          });
          return result;
        }),
    );

    server.registerTool(
      'aggregate',
      {
        description: d.aggregate,
        inputSchema: {
          ...identity,
          table: tableArg,
          op: z.enum(AGGREGATE_OPS),
          field: z.string().optional().describe('Not needed for count'),
          group_by: z.array(z.string()).optional().describe('Up to 3 fields'),
          filters: filtersArg,
        },
      },
      ({ companyId, agentId, table, op, field, group_by, filters }) =>
        this.run(async () => {
          const rows = await this.records.aggregate(companyId, table, {
            op,
            field,
            groupBy: group_by,
            filters,
          });
          this.read(companyId, agentId, {
            tool: 'aggregate',
            table,
            op,
            field,
            groupBy: group_by ?? [],
            filters: filters ?? [],
            groups: rows.length,
          });
          return rows;
        }),
    );

    server.registerTool(
      'alter_table',
      {
        description: d.alter_table,
        inputSchema: {
          ...identity,
          table: tableArg,
          action: z.enum(TABLE_CHANGE_OPS),
          column: z.string().optional(),
          new_name: z.string().optional(),
          type: z.enum(['string', 'number', 'integer', 'boolean']).optional(),
          format: z.literal('date').optional(),
          description: z.string().optional(),
          default: z.unknown().optional(),
          required: z.boolean().optional(),
          fields: z.array(z.string()).optional(),
        },
      },
      ({ companyId, agentId, table, ...args }) =>
        this.run(async () => {
          const change = tableChange(args);
          // Deleting a column deletes data from every record: a person's call.
          if (change.op === 'delete_column') {
            checkDelete(
              await this.records.describeTable(companyId, table),
              change.column,
            );
            return interpolate(recordsPrompts.delete_column_ask_user, {
              column: change.column,
              table,
            });
          }
          if (change.op === 'add_column' && change.default !== undefined) {
            const refused = await this.refuseDoNotStore(
              companyId,
              agentId,
              'alter_table',
              table,
              { [change.column]: change.default },
            );
            if (refused) return refused;
          }
          const { definition, before, rewritten } =
            await this.records.alterTable(companyId, table, change, {
              allowNarrow: false,
            });
          // Definitions and a count only: a default value is row data.
          this.change(companyId, agentId, {
            action: 'alter_table',
            op: change.op,
            table,
            before,
            after: definition,
            rewritten,
          });
          return { table: definition, rewritten };
        }),
    );

    server.registerTool(
      'do_not_store',
      {
        description: d.do_not_store,
        inputSchema: {
          ...identity,
          action: z.enum(['add', 'remove', 'change']),
          value: z.string().describe('A name, email address or similar'),
          reason: z.string().describe('Why, in a sentence'),
        },
      },
      ({ companyId, agentId, action, value, reason }) =>
        this.run(async () => {
          // Taking someone off the list is a person's decision, not an agent's.
          if (action !== 'add') {
            return interpolate(recordsPrompts.do_not_store_ask_user, {
              action: action === 'remove' ? 'removed' : 'changed',
            });
          }
          try {
            const entry = await this.records.addDoNotStore(
              companyId,
              { value, note: reason },
              { role: 'agent', id: agentId },
            );
            // The entry's id only: the audit log mustn't collect the very
            // details the list exists to keep out.
            this.change(companyId, agentId, {
              action: 'do_not_store_add',
              entryId: entry.id,
            });
            return recordsPrompts.do_not_store_added;
          } catch (e) {
            if (e instanceof RecordsError && e.code === 'conflict') {
              return recordsPrompts.do_not_store_already;
            }
            throw e;
          }
        }),
    );

    return server;
  }

  /**
   * The refusal for a record holding a do-not-store entry, or `undefined`
   * when it may be stored. A refusal is audited by field name only.
   */
  private async refuseDoNotStore(
    companyId: string,
    agentId: string,
    tool: 'insert' | 'update' | 'alter_table',
    table: string,
    data: Record<string, unknown>,
  ): Promise<
    { status: 'not_stored'; fields: string[]; note: string } | undefined
  > {
    const fields = await this.records.doNotStoreMatches(companyId, [data]);
    if (fields.length === 0) return undefined;
    this.read(companyId, agentId, {
      tool,
      table,
      outcome: 'do_not_store',
      fields,
    });
    return {
      status: 'not_stored',
      fields,
      note: interpolate(recordsPrompts.do_not_store_refused, {
        fields: fields.map((f) => `'${f}'`).join(', '),
      }),
    };
  }

  /** Runs a tool body, returning its result as JSON and a {@link RecordsError} as a correctable error. */
  private async run(body: () => Promise<unknown>): Promise<ToolResult> {
    try {
      const result = await body();
      return ok(typeof result === 'string' ? result : JSON.stringify(result));
    } catch (e) {
      if (e instanceof RecordsError) return err(e.message);
      throw e;
    }
  }

  /** Audits a change to the records, with the values either side. */
  private change(
    companyId: string,
    agentId: string,
    detail: Record<string, unknown>,
  ): void {
    this.audit.record(
      companyId,
      AUDIT_ROLE,
      agentId,
      AuditEventType.StateChange,
      { source: 'records', ...detail },
    );
  }

  /** Audits a read of records, naming what was read. */
  private read(
    companyId: string,
    agentId: string,
    detail: Record<string, unknown>,
  ): void {
    this.audit.record(companyId, AUDIT_ROLE, agentId, AuditEventType.ToolCall, {
      source: 'records',
      ...detail,
    });
  }
}
