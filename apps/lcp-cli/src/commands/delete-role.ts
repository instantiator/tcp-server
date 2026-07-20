import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { addCompanyOptions, addRoleOptions } from '../lib/core/entity-ref';
import { deleteRoleAction } from '../lib/crud/role.action';

/** Registers the `delete-role` command. */
export function registerDeleteRole(program: Command): void {
  const cmd = program
    .command('delete-role')
    .description(
      'Delete a role and everything tied to it (agents, knowledge, conversations, ...)',
    );
  addRoleOptions(cmd);
  addCompanyOptions(cmd);
  cmd
    .option('-f, --force', 'Skip the y/n confirmation prompt')
    .action(
      (cmdOpts: {
        role?: string;
        roleId?: string;
        roleSlug?: string;
        company?: string;
        companyId?: string;
        companySlug?: string;
        force?: boolean;
      }) => deleteRoleAction(getGlobalOptions(program), cmdOpts),
    );
}
