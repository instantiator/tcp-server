import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { addCompanyOptions } from '../lib/core/entity-ref';
import {
  ALTER_OPS,
  alterTableAction,
  AlterTableOpts,
} from '../lib/records/alter-table.action';

/** Adds, renames or deletes a record table's columns, or changes its primary key. */
export function registerAlterTable(program: Command): void {
  const cmd = program
    .command('alter-table')
    .description("Change a company's record table: its columns or primary key")
    .argument('<op>', `The change: ${ALTER_OPS.join(' | ')}`)
    .requiredOption('--table <name>', 'Record table name')
    .option('--column <name>', 'The column to add, rename or delete')
    .option('--new-name <name>', 'rename-column: the new name')
    .option('--type <type>', 'add-column: string, number, integer or boolean')
    .option('--format <format>', 'add-column: date, for a YYYY-MM-DD string')
    .option('--description <text>', 'add-column: what the column holds')
    .option(
      '--default <value>',
      'add-column: given to every existing record (JSON if it parses, else text)',
    )
    .option('--required', 'add-column: the column must always have a value')
    .option('--fields <a,b>', 'set-key: the key fields, comma-separated')
    .option(
      '--confirm-do-not-store',
      'Store a default that matches the do-not-store list',
    )
    .option('--yes', 'delete-column: confirm the values are deleted too');
  addCompanyOptions(cmd);
  cmd.action((op: string, cmdOpts: Omit<AlterTableOpts, 'op'>) =>
    alterTableAction(getGlobalOptions(program), { ...cmdOpts, op }),
  );
}
