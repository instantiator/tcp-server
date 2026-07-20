import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { addCompanyOptions, addRoleOptions } from '../lib/core/entity-ref';
import { setRoleAction } from '../lib/crud/role.action';

/** Registers the `set-role` command. */
export function registerSetRole(program: Command): void {
  const cmd = program
    .command('set-role')
    .description('Create or update a role (reads JSON from --input or stdin)');
  addCompanyOptions(cmd);
  addRoleOptions(cmd);
  cmd
    .option('-i, --input <json>', 'Role JSON (DeepPartial<LcpRole>)')
    .action(
      (cmdOpts: {
        company?: string;
        companyId?: string;
        companySlug?: string;
        role?: string;
        roleId?: string;
        roleSlug?: string;
        input?: string;
      }) => setRoleAction(getGlobalOptions(program), cmdOpts),
    );
}
