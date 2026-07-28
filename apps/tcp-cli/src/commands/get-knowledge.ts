import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { addCompanyOptions, addRoleOptions } from '../lib/core/entity-ref';
import { getKnowledgeAction } from '../lib/docs/get-knowledge.action';

/**
 * Retrieves a knowledge-base document's content for a role or a company's
 * shared knowledge.
 */
export function registerGetKnowledge(program: Command): void {
  const cmd = program
    .command('get-knowledge')
    .description(
      'Get a knowledge-base document for a role or company (shared knowledge)',
    );
  addRoleOptions(cmd);
  addCompanyOptions(cmd);
  cmd
    .requiredOption('-f, --file <filename>', 'Filename to retrieve')
    .option('-o, --out <path>', 'Save to a local file instead of stdout')
    .action(
      (cmdOpts: {
        role?: string;
        roleId?: string;
        roleSlug?: string;
        company?: string;
        companyId?: string;
        companySlug?: string;
        file: string;
        out?: string;
      }) => getKnowledgeAction(getGlobalOptions(program), cmdOpts),
    );
}
