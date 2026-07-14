import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { storeKnowledgeAction } from '../lib/docs/store-knowledge.action';

/**
 * Uploads (or overwrites) a single OKF Markdown document into a role's
 * knowledge base, or a company's shared knowledge.
 */
export function registerStoreKnowledge(program: Command): void {
  program
    .command('store-knowledge')
    .description(
      'Upload an OKF Markdown document to a role or company (shared knowledge) knowledge base',
    )
    .option('-r, --role <slug-or-id>', 'Role slug or UUID')
    .option('-c, --company <slug-or-id>', 'Company slug or UUID')
    .requiredOption('-s, --source <path>', 'Local Markdown file path to upload')
    .option(
      '-t, --target <filename>',
      'Filename to store as (defaults to the source filename)',
    )
    .action(
      (cmdOpts: {
        role?: string;
        company?: string;
        source: string;
        target?: string;
      }) => storeKnowledgeAction(getGlobalOptions(program), cmdOpts),
    );
}
