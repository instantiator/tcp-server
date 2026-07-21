import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { addCompanyOptions, addRoleOptions } from '../lib/core/entity-ref';
import { getKnowledgeIndexStatusAction } from '../lib/docs/get-knowledge-index-status.action';

/**
 * Reports knowledge-index status (document/chunk counts, size, generation,
 * and whether a rebuild is in progress) for a role, or for a company's
 * shared scope plus every role.
 */
export function registerGetKnowledgeIndexStatus(program: Command): void {
  const cmd = program
    .command('get-knowledge-index-status')
    .description(
      "Report knowledge-index status for a role, or a company's shared scope plus every role",
    );
  addRoleOptions(cmd);
  addCompanyOptions(cmd);
  cmd.action(
    (cmdOpts: {
      role?: string;
      roleId?: string;
      roleSlug?: string;
      company?: string;
      companyId?: string;
      companySlug?: string;
    }) => getKnowledgeIndexStatusAction(getGlobalOptions(program), cmdOpts),
  );
}
