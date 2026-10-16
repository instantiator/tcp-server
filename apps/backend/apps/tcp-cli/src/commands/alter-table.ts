import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { addCompanyOptions } from '../lib/core/entity-ref';
import {
  ALTER_OPS,
  alterTableAction,
  AlterTableOpts,
} from '../lib/records/alter-table.action';

/** Changes a record table's columns, primary key or unique keys. */
export function registerAlterTable(program: Command): void {
  const cmd = program
    .command('alter-table')
    .description(
      "Change a company's record table: its columns, keys or column types",
    )
    .argument('<op>', `The change: ${ALTER_OPS.join(' | ')}`)
    .requiredOption('--table <name>', 'Record table name')
    .option('--column <name>', 'The column to add, rename, delete or retype')
    .option('--new-name <name>', 'rename-column: the new name')
    .option(
      '--type <type>',
      'add-column, retype-column: string, number, integer or boolean',
    )
    .option(
      '--format <format>',
      'add-column, retype-column: date, for a YYYY-MM-DD string',
    )
    .option('--description <text>', 'add-column: what the column holds')
    .option(
      '--default <value>',
      'add-column: given to every existing record (JSON if it parses, else text)',
    )
    .option('--required', 'add-column: the column must always have a value')
    .option(
      '--fields <a,b>',
      'set-key, add-unique-key, drop-unique-key: the key fields, comma-separated',
    )
    .option(
      '--blank-unconvertible',
      "retype-column: blank the values that don't convert (needs --yes)",
    )
    .option(
      '--confirm-do-not-store',
      'Store a default that matches the do-not-store list',
    )
    .option(
      '--yes',
      'delete-column, retype-column --blank-unconvertible: confirm values are removed',
    );
  addCompanyOptions(cmd);
  cmd.action((op: string, cmdOpts: Omit<AlterTableOpts, 'op'>) =>
    alterTableAction(getGlobalOptions(program), { ...cmdOpts, op }),
  );
}
