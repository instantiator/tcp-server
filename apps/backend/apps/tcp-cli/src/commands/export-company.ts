import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { addCompanyOptions, EntityRefOpts } from '../lib/core/entity-ref';
import { exportCompanyAction } from '../lib/templates/export-company.action';

/** Registers the `export-company` command. */
export function registerExportCompany(program: Command): void {
  const cmd = program
    .command('export-company')
    .description('Export a company as a template zip');
  addCompanyOptions(cmd);
  cmd
    .option('--no-models', 'Leave the models out of the template')
    .option('-o, --output <file>', 'File to write (default: <slug>.zip)')
    .action((cmdOpts: EntityRefOpts & { models?: boolean; output?: string }) =>
      exportCompanyAction(getGlobalOptions(program), cmdOpts),
    );
}
