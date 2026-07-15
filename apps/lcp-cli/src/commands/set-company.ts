import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { addCompanyOptions } from '../lib/core/entity-ref';
import { setCompanyAction } from '../lib/crud/company.action';

/** Registers the `set-company` command. */
export function registerSetCompany(program: Command): void {
  const cmd = program
    .command('set-company')
    .description(
      'Create or update a company (reads JSON from --input or stdin)',
    );
  addCompanyOptions(cmd);
  cmd
    .option('-i, --input <json>', 'Company JSON (DeepPartial<LcpCompany>)')
    .action(
      (cmdOpts: {
        company?: string;
        companyId?: string;
        companySlug?: string;
        input?: string;
      }) => setCompanyAction(getGlobalOptions(program), cmdOpts),
    );
}
