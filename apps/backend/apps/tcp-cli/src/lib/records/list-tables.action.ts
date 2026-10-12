import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
import { EntityRefOpts, resolveCompanyId } from '../core/entity-ref';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

interface RecordTableSummary {
  name: string;
  purpose: string;
  records: number;
  updatedAt: string;
}

/**
 * Lists a company's record tables.
 *
 * stdout: JSON array of `{ name, purpose, records, updatedAt }` objects.
 */
export function listTablesAction(
  opts: GlobalOptions,
  cmdOpts: EntityRefOpts,
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
    const api = apiOptions(opts, token);
    const companyId = await resolveCompanyId(api, cmdOpts);
    const tables = await apiRequest<RecordTableSummary[]>(
      api,
      'GET',
      `/api/company/${companyId}/records/tables`,
    );
    process.stdout.write(JSON.stringify(tables, null, 2) + '\n');
  });
}
