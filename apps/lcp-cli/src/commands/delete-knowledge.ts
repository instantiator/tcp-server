import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { deleteKnowledgeAction } from '../lib/docs/delete-knowledge.action';

/**
 * Deletes a knowledge-base document by filename, from a role's knowledge
 * base or a company's shared knowledge. Idempotent.
 */
export function registerDeleteKnowledge(program: Command): void {
  program
    .command('delete-knowledge')
    .description(
      'Delete a knowledge-base document from a role or company (shared knowledge)',
    )
    .option('-r, --role <slug-or-id>', 'Role slug or UUID')
    .option('-c, --company <slug-or-id>', 'Company slug or UUID')
    .requiredOption('-f, --file <filename>', 'Filename to delete')
    .action((cmdOpts: { role?: string; company?: string; file: string }) =>
      deleteKnowledgeAction(getGlobalOptions(program), cmdOpts),
    );
}
