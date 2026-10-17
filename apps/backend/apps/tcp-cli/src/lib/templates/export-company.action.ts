import * as fs from 'fs';
import * as path from 'path';
import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiDownload } from '../core/api';
import { EntityRefOpts, resolveCompanyId } from '../core/entity-ref';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

/**
 * Exports a company as a template zip. `--no-models` leaves the models out
 * (commander sets `models: false`). The file defaults to the server's name,
 * `<slug>.zip`.
 *
 * stdout: `{ target, size }` JSON for the file written.
 */
export function exportCompanyAction(
  opts: GlobalOptions,
  cmdOpts: EntityRefOpts & { models?: boolean; output?: string },
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
    const api = apiOptions(opts, token);
    const companyId = await resolveCompanyId(api, cmdOpts);
    const query = cmdOpts.models === false ? '?models=false' : '';
    const { data, filename } = await apiDownload(
      api,
      `/api/company/${companyId}/export${query}`,
    );

    const target = path.resolve(cmdOpts.output ?? filename);
    fs.writeFileSync(target, data);
    process.stderr.write(`Saved to ${target}\n`);
    process.stdout.write(
      JSON.stringify({ target, size: data.length }, null, 2) + '\n',
    );
  });
}
