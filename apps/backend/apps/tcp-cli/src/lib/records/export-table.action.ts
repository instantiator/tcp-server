import * as fs from 'fs';
import * as path from 'path';
import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiDownload } from '../core/api';
import { EntityRefOpts, resolveCompanyId } from '../core/entity-ref';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

/**
 * Exports one record table as CSV.
 *
 * Without `--target` the raw CSV bytes go to stdout and nothing else does, so
 * the output can be piped. A `--target` that is an existing directory receives
 * the server's suggested filename; any other `--target` is the file path.
 *
 * stdout: the CSV, or `{ source, target, size }` JSON when a file is written.
 */
export function exportTableAction(
  opts: GlobalOptions,
  cmdOpts: EntityRefOpts & { table: string; target?: string },
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
    const api = apiOptions(opts, token);
    const companyId = await resolveCompanyId(api, cmdOpts);
    const { data, filename } = await apiDownload(
      api,
      `/api/company/${companyId}/records/tables/${encodeURIComponent(cmdOpts.table)}/csv`,
    );

    if (!cmdOpts.target) {
      process.stdout.write(data);
      return;
    }

    const isDir =
      fs.existsSync(cmdOpts.target) &&
      fs.statSync(cmdOpts.target).isDirectory();
    const target = path.resolve(
      isDir ? path.join(cmdOpts.target, filename) : cmdOpts.target,
    );
    fs.writeFileSync(target, data);

    process.stderr.write(`Saved to ${target}\n`);
    process.stdout.write(
      JSON.stringify(
        { source: cmdOpts.table, target, size: data.length },
        null,
        2,
      ) + '\n',
    );
  });
}
