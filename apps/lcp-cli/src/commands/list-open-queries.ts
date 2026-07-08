import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { listOpenQueriesAction } from '../lib/queries/list-open-queries.action';

/**
 * Lists open agent-to-human query conversations.
 *
 * stdout: table (default), JSON, or CSV depending on `--format`.
 */
export function registerListOpenQueries(program: Command): void {
  program
    .command('list-open-queries')
    .description('List open agent-to-human queries awaiting a response')
    .option('-c, --company-id <uuid>', 'Filter to a specific company')
    .option(
      '--company-slug <slug>',
      'Filter to a specific company, by slug instead of ID',
    )
    .option(
      '-f, --format <fmt>',
      'Output format: table, json, or csv (default: table)',
      'table',
    )
    .action(
      (cmdOpts: { companyId?: string; companySlug?: string; format: string }) =>
        listOpenQueriesAction(getGlobalOptions(program), cmdOpts),
    );
}
