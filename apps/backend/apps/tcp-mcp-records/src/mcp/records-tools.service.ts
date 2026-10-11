import {
  AGGREGATE_OPS,
  AuditClientService,
  AuditEventType,
  FILTER_OPS,
  RecordsError,
  RecordsService,
  type RecordRef,
  ToolResult,
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

const tableArg = z.string().describe('The table name, e.g. "orders".');
const freeForm = z.record(z.string(), z.unknown());
const filterValue = z
  .union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.union([z.string(), z.number()])),
  ])
  .describe('The value to compare with; a list for "in".');
const filtersArg = z
  .array(
    z.object({
      field: z.string().describe('A field of the table.'),
      op: z.enum(FILTER_OPS).describe('How to compare.'),
      value: filterValue,
    }),
  )
  .optional()
  .describe('Conditions every matching record meets.');
const refArgs = {
  id: z.string().optional().describe('The record id. Give this or `key`.'),
  key: freeForm
    .optional()
    .describe(
      'The primary key values, e.g. {"order_id": "A1"}. Give this or `id`.',
    ),
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
          name: z.string().describe('The new table name, e.g. "orders".'),
          purpose: z
            .string()
            .describe('What the table holds, shown to every agent.'),
          schema: freeForm.describe('A JSON Schema object for one record.'),
          primary_key: z
            .array(z.string())
            .describe('The field(s) that identify a record.'),
          unique_keys: z
            .array(z.array(z.string()))
            .optional()
            .describe(
              'Other field sets that must be unique, e.g. [["email"]].',
            ),
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
          record: freeForm.describe('The record, as field: value pairs.'),
        },
      },
      ({ companyId, agentId, table, record }) =>
        this.run(async () => {
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
          changes: freeForm.describe(
            'The fields to change; null removes a field.',
          ),
        },
      },
      ({ companyId, agentId, table, changes, ...ref }) =>
        this.run(async () => {
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
            .optional()
            .describe('Sort order, first field first.'),
          limit: z
            .number()
            .int()
            .optional()
            .describe('Most records to return (default 50, at most 200).'),
          offset: z
            .number()
            .int()
            .optional()
            .describe('Records to skip, for the next page.'),
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
          op: z.enum(AGGREGATE_OPS).describe('What to compute.'),
          field: z
            .string()
            .optional()
            .describe('The field to compute over (not needed for count).'),
          group_by: z
            .array(z.string())
            .optional()
            .describe('Fields to group by, at most 3.'),
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

    return server;
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
