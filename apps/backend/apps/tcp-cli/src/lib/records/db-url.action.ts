import { GlobalOptions, apiOptions } from '../core/cli-options';
import { EntityRefOpts, resolveCompanyId } from '../core/entity-ref';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

/** The tables a company's rows live in, with the column that scopes them. */
const RECORD_TABLES = ['record_table', 'record', 'record_key'];

/**
 * Prints the host-facing database connection URL for external tools.
 *
 * The URL comes from the environment that `./tcp-cli.sh` derives, never from
 * the API. Authentication is needed only when a company is named, to resolve
 * its id for the row filter.
 *
 * stdout: `{ database, url }` JSON, plus `{ companyId, tables, filter }` when
 * `--records` is combined with a company.
 */
export function dbUrlAction(
  opts: GlobalOptions,
  cmdOpts: EntityRefOpts & { records?: boolean },
): Promise<void> {
  return runCommand(async () => {
    const hostUrl = process.env['TCP_HOST_DATABASE_URL'];
    if (!hostUrl) {
      throw new Error(
        'TCP_HOST_DATABASE_URL is not set. Run through ./tcp-cli.sh, which derives it from the env file.',
      );
    }

    const out: Record<string, unknown> = cmdOpts.records
      ? {
          database: 'records',
          url: process.env['RECORDS_DATABASE_URL'] || hostUrl,
        }
      : { database: 'tcp-server', url: hostUrl };

    const hasCompany = Boolean(
      cmdOpts.company || cmdOpts.companyId || cmdOpts.companySlug,
    );
    if (cmdOpts.records && hasCompany) {
      const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
      const companyId = await resolveCompanyId(
        apiOptions(opts, token),
        cmdOpts,
      );
      out['companyId'] = companyId;
      out['tables'] = RECORD_TABLES;
      out['filter'] = `"companyId" = '${companyId}'`;
    }

    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  });
}
