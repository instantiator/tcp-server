import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { addCompanyOptions, addRoleOptions } from '../lib/core/entity-ref';
import { deleteKnowledgeAction } from '../lib/docs/delete-knowledge.action';

/**
 * Deletes a knowledge-base document by filename, from a role's knowledge
 * base or a company's shared knowledge. Idempotent.
 */
export function registerDeleteKnowledge(program: Command): void {
  const cmd = program
    .command('delete-knowledge')
    .description(
      'Delete a knowledge-base document from a role or company (shared knowledge)',
    );
  addRoleOptions(cmd);
  addCompanyOptions(cmd);
  cmd
    .requiredOption('-f, --file <filename>', 'Filename to delete')
    .action(
      (cmdOpts: {
        role?: string;
        roleId?: string;
        roleSlug?: string;
        company?: string;
        companyId?: string;
        companySlug?: string;
        file: string;
      }) => deleteKnowledgeAction(getGlobalOptions(program), cmdOpts),
    );
}
