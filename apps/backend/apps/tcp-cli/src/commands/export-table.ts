import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { addCompanyOptions, EntityRefOpts } from '../lib/core/entity-ref';
import { exportTableAction } from '../lib/records/export-table.action';

/** Exports one of a company's record tables as CSV. */
export function registerExportTable(program: Command): void {
  const cmd = program
    .command('export-table')
    .description("Export a company's record table as CSV")
    .requiredOption('--table <name>', 'Record table name')
    .option(
      '--target <path>',
      'File or directory to write (default: CSV to stdout)',
    );
  addCompanyOptions(cmd);
  cmd.action((cmdOpts: EntityRefOpts & { table: string; target?: string }) =>
    exportTableAction(getGlobalOptions(program), cmdOpts),
  );
}
