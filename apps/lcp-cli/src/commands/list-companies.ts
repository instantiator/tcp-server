import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { listCompaniesAction } from '../lib/crud/company.action';

/** Registers the `list-companies` command. */
export function registerListCompanies(program: Command): void {
  program
    .command('list-companies')
    .description('List all companies')
    .action(() => listCompaniesAction(getGlobalOptions(program)));
}
