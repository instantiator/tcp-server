import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { deleteCompanyAction } from '../lib/crud/company.action';

/** Registers the `delete-company` command. */
export function registerDeleteCompany(program: Command): void {
  program
    .command('delete-company')
    .description(
      'Delete a company and everything in it (roles, agents, conversations, ...)',
    )
    .option('-c, --company-id <uuid>', 'Company UUID to delete')
    .option(
      '--company-slug <slug>',
      'Company slug to delete instead of --company-id',
    )
    .option('-f, --force', 'Skip the y/n confirmation prompt')
    .action(
      (cmdOpts: {
        companyId?: string;
        companySlug?: string;
        force?: boolean;
      }) => deleteCompanyAction(getGlobalOptions(program), cmdOpts),
    );
}
