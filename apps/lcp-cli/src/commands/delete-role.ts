import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { deleteRoleAction } from '../lib/crud/role.action';

/** Registers the `delete-role` command. */
export function registerDeleteRole(program: Command): void {
  program
    .command('delete-role')
    .description(
      'Delete a role and everything tied to it (agents, knowledge, conversations, ...)',
    )
    .option('-r, --role-id <uuid>', 'Role UUID to delete')
    .option(
      '--role-slug <slug>',
      'Role slug to delete instead of --role-id (requires --company-id or --company-slug)',
    )
    .option('-c, --company-id <uuid>', 'Company UUID (for --role-slug)')
    .option('--company-slug <slug>', 'Company slug (for --role-slug)')
    .option('-f, --force', 'Skip the y/n confirmation prompt')
    .action(
      (cmdOpts: {
        roleId?: string;
        roleSlug?: string;
        companyId?: string;
        companySlug?: string;
        force?: boolean;
      }) => deleteRoleAction(getGlobalOptions(program), cmdOpts),
    );
}
