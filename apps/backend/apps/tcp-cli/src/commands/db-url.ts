import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { addCompanyOptions, EntityRefOpts } from '../lib/core/entity-ref';
import { dbUrlAction } from '../lib/records/db-url.action';

/** Prints the host-facing database URL (run through ./tcp-cli.sh). */
export function registerDbUrl(program: Command): void {
  const cmd = program
    .command('db-url')
    .description('Print the database connection URL for external tools')
    .option('--records', 'The records database, not the tcp-server one');
  addCompanyOptions(cmd);
  cmd.action((cmdOpts: EntityRefOpts & { records?: boolean }) =>
    dbUrlAction(getGlobalOptions(program), cmdOpts),
  );
}
