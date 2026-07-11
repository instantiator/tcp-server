import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { getKnowledgeAction } from '../lib/docs/get-knowledge.action';

/**
 * Retrieves a knowledge-base document's content for a role or a company's
 * shared knowledge.
 */
export function registerGetKnowledge(program: Command): void {
  program
    .command('get-knowledge')
    .description(
      'Get a knowledge-base document for a role or company (shared knowledge)',
    )
    .option('-r, --role <slug-or-id>', 'Role slug or UUID')
    .option('-c, --company <slug-or-id>', 'Company slug or UUID')
    .requiredOption('-f, --file <filename>', 'Filename to retrieve')
    .option('-o, --out <path>', 'Save to a local file instead of stdout')
    .action(
      (cmdOpts: {
        role?: string;
        company?: string;
        file: string;
        out?: string;
      }) => getKnowledgeAction(getGlobalOptions(program), cmdOpts),
    );
}
