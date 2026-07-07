import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { setCompanyAction } from '../lib/crud/company.action';

/** Registers the `set-company` command. */
export function registerSetCompany(program: Command): void {
  program
    .command('set-company')
    .description(
      'Create or update a company (reads JSON from --input or stdin)',
    )
    .option(
      '-c, --company-id <uuid>',
      'Company UUID to update (overrides any "id" in the JSON body)',
    )
    .option(
      '--company-slug <slug>',
      'Company slug to update instead of --company-id',
    )
    .option('-i, --input <json>', 'Company JSON (DeepPartial<LcpCompany>)')
    .action(
      (cmdOpts: { companyId?: string; companySlug?: string; input?: string }) =>
        setCompanyAction(getGlobalOptions(program), cmdOpts),
    );
}
