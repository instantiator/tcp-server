import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { addCompanyOptions, addRoleOptions } from '../lib/core/entity-ref';
import { listKnowledgeAction } from '../lib/docs/list-knowledge.action';

/**
 * Lists OKF knowledge-base documents stored for a role or a company's
 * shared knowledge.
 */
export function registerListKnowledge(program: Command): void {
  const cmd = program
    .command('list-knowledge')
    .description(
      'List knowledge-base documents for a role or company (shared knowledge)',
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
    }) => listKnowledgeAction(getGlobalOptions(program), cmdOpts),
  );
}
