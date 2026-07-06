import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { listRolesAction } from '../lib/crud/role.action';

/**
 * Lists roles grouped by company.
 *
 * Without --company-id: fetches all companies then their roles (N+1 calls).
 * With --company-id: fetches a single company and its roles.
 *
 * stdout: `{ id, name, roles: { id, name }[] }[]`
 */
export function registerListRoles(program: Command): void {
  program
    .command('list-roles')
    .description('List roles grouped by company')
    .option('-c, --company-id <uuid>', 'Filter to a single company')
    .action((cmdOpts: { companyId?: string }) =>
      listRolesAction(getGlobalOptions(program), cmdOpts),
    );
}
