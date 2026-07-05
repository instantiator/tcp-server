import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { readQueryAction } from '../lib/queries/read-query.action';

/**
 * Displays the full content of a single agent query conversation,
 * including any prior messages.
 */
export function registerReadQuery(program: Command): void {
  program
    .command('read-query <slug>')
    .description('Show the full question, context, and messages for a query')
    .action((slug: string) => readQueryAction(getGlobalOptions(program), slug));
}
