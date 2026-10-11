import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { addCompanyOptions, EntityRefOpts } from '../lib/core/entity-ref';
import { listTablesAction } from '../lib/records/list-tables.action';

/** Lists a company's record tables. */
export function registerListTables(program: Command): void {
  const cmd = program
    .command('list-tables')
    .description("List a company's record tables");
  addCompanyOptions(cmd);
  cmd.action((cmdOpts: EntityRefOpts) =>
    listTablesAction(getGlobalOptions(program), cmdOpts),
  );
}
