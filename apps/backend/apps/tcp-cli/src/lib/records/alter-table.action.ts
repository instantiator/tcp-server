import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
import { EntityRefOpts, resolveCompanyId } from '../core/entity-ref';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

/** The changes `alter-table` offers. */
export const ALTER_OPS = [
  'add-column',
  'rename-column',
  'delete-column',
  'set-key',
] as const;

/** What `alter-table` is given on the command line. */
export interface AlterTableOpts extends EntityRefOpts {
  table: string;
  op: string;
  column?: string;
  newName?: string;
  type?: string;
  format?: string;
  description?: string;
  default?: string;
  required?: boolean;
  fields?: string;
  confirmDoNotStore?: boolean;
  yes?: boolean;
}

/** One HTTP request, relative to the table's URL. */
export interface AlterRequest {
  method: 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  path: string;
  body?: unknown;
}

/** A default is JSON when it parses (`1`, `true`, `"x"`), else the text as typed. */
function parseDefault(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Turns the command line into the request that makes the change, naming any
 * option the change needs but lacks.
 */
export function alterRequest(o: AlterTableOpts): AlterRequest {
  const need = (value: string | undefined, flag: string): string => {
    if (!value) throw new Error(`${o.op} needs ${flag}`);
    return value;
  };
  const columns = `/columns`;
  switch (o.op) {
    case 'add-column':
      return {
        method: 'POST',
        path: columns,
        body: {
          column: need(o.column, '--column'),
          type: need(o.type, '--type'),
          format: o.format,
          description: o.description,
          default:
            o.default === undefined ? undefined : parseDefault(o.default),
          required: o.required,
        },
      };
    case 'rename-column':
      return {
        method: 'PATCH',
        path: `${columns}/${encodeURIComponent(need(o.column, '--column'))}`,
        body: { newName: need(o.newName, '--new-name') },
      };
    case 'delete-column':
      if (!o.yes) {
        throw new Error(
          'delete-column needs --yes: it deletes the column and its value from every record',
        );
      }
      return {
        method: 'DELETE',
        path: `${columns}/${encodeURIComponent(need(o.column, '--column'))}`,
      };
    case 'set-key':
      return {
        method: 'PUT',
        path: '/primary-key',
        body: {
          fields: need(o.fields, '--fields')
            .split(',')
            .map((f) => f.trim()),
        },
      };
    default:
      throw new Error(`Unknown change "${o.op}": use ${ALTER_OPS.join(', ')}`);
  }
}

/**
 * Changes a record table's columns or primary key, as the web UI's Columns
 * dialog does.
 *
 * stdout: the table's new definition as JSON.
 */
export function alterTableAction(
  opts: GlobalOptions,
  cmdOpts: AlterTableOpts,
): Promise<void> {
  return runCommand(async () => {
    const { method, path, body } = alterRequest(cmdOpts);
    const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
    const api = apiOptions(opts, token);
    const companyId = await resolveCompanyId(api, cmdOpts);
    const confirm = cmdOpts.confirmDoNotStore ? '?confirmDoNotStore=true' : '';
    const definition = await apiRequest<unknown>(
      api,
      method,
      `/api/company/${companyId}/records/tables/${encodeURIComponent(cmdOpts.table)}${path}${confirm}`,
      body,
    );
    process.stdout.write(JSON.stringify(definition, null, 2) + '\n');
  });
}
