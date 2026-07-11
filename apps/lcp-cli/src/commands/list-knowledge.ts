import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { listKnowledgeAction } from '../lib/docs/list-knowledge.action';

/**
 * Lists OKF knowledge-base documents stored for a role or a company's
 * shared knowledge.
 */
export function registerListKnowledge(program: Command): void {
  program
    .command('list-knowledge')
    .description(
      'List knowledge-base documents for a role or company (shared knowledge)',
    )
    .option('-r, --role <slug-or-id>', 'Role slug or UUID')
    .option('-c, --company <slug-or-id>', 'Company slug or UUID')
    .action((cmdOpts: { role?: string; company?: string }) =>
      listKnowledgeAction(getGlobalOptions(program), cmdOpts),
    );
}
