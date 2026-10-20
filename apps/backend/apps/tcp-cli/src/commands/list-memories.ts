import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { addCompanyOptions, addRoleOptions } from '../lib/core/entity-ref';
import { listMemoriesAction } from '../lib/memory/list-memories.action';

/** Lists a role's memories, newest first. */
export function registerListMemories(program: Command): void {
  const cmd = program
    .command('list-memories')
    .description("List a role's memories (newest first)");
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
    }) => listMemoriesAction(getGlobalOptions(program), cmdOpts),
  );
}
