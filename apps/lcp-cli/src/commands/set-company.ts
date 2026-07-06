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
    .option('-i, --input <json>', 'Company JSON (DeepPartial<LcpCompany>)')
    .action((cmdOpts: { input?: string }) =>
      setCompanyAction(getGlobalOptions(program), cmdOpts),
    );
}
