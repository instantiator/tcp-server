import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { addCompanyOptions } from '../lib/core/entity-ref';
import { listRolesAction } from '../lib/crud/role.action';

/**
 * Lists roles grouped by company.
 *
 * Without a company flag: fetches all companies then their roles (N+1 calls).
 * With one: fetches a single company and its roles.
 *
 * stdout: `{ id, slug, name, description, roles: { id, slug, name, description, knowledgeDomains }[] }[]`
 */
export function registerListRoles(program: Command): void {
  const cmd = program
    .command('list-roles')
    .description('List roles grouped by company');
  addCompanyOptions(cmd);
  cmd.action(
    (cmdOpts: { company?: string; companyId?: string; companySlug?: string }) =>
      listRolesAction(getGlobalOptions(program), cmdOpts),
  );
}
