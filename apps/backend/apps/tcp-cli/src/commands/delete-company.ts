import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { addCompanyOptions } from '../lib/core/entity-ref';
import { deleteCompanyAction } from '../lib/crud/company.action';

/** Registers the `delete-company` command. */
export function registerDeleteCompany(program: Command): void {
  const cmd = program
    .command('delete-company')
    .description(
      'Delete a company and everything in it (roles, agents, conversations, ...)',
    );
  addCompanyOptions(cmd);
  cmd
    .option('-f, --force', 'Skip the y/n confirmation prompt')
    .action(
      (cmdOpts: {
        company?: string;
        companyId?: string;
        companySlug?: string;
        force?: boolean;
      }) => deleteCompanyAction(getGlobalOptions(program), cmdOpts),
    );
}
