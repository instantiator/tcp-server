import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { setRoleAction } from '../lib/crud/role.action';

/** Registers the `set-role` command. */
export function registerSetRole(program: Command): void {
  program
    .command('set-role')
    .description('Create or update a role (reads JSON from --input or stdin)')
    .option(
      '-c, --company-id <uuid>',
      'Company UUID (required when creating a new role, or when updating via --role-slug)',
    )
    .option(
      '--company-slug <slug>',
      'Company slug instead of ID (required when creating a new role, or when updating via --role-slug)',
    )
    .option(
      '-r, --role-id <uuid>',
      'Role UUID to update (overrides any "id" in the JSON body)',
    )
    .option(
      '--role-slug <slug>',
      'Role slug to update instead of --role-id (requires --company-id or --company-slug)',
    )
    .option('-i, --input <json>', 'Role JSON (DeepPartial<LcpRole>)')
    .action(
      (cmdOpts: {
        companyId?: string;
        companySlug?: string;
        roleId?: string;
        roleSlug?: string;
        input?: string;
      }) => setRoleAction(getGlobalOptions(program), cmdOpts),
    );
}
