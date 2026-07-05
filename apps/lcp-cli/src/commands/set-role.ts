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
      'Company UUID (required when creating a new role)',
    )
    .option('-i, --input <json>', 'Role JSON (DeepPartial<LcpRole>)')
    .action((cmdOpts: { companyId?: string; input?: string }) =>
      setRoleAction(getGlobalOptions(program), cmdOpts),
    );
}
