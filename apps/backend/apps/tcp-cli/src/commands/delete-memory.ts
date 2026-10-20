import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { addCompanyOptions, addRoleOptions } from '../lib/core/entity-ref';
import { deleteMemoryAction } from '../lib/memory/delete-memory.action';

/** Deletes a role's memory, confirming first unless forced. */
export function registerDeleteMemory(program: Command): void {
  const cmd = program
    .command('delete-memory')
    .description(
      "Delete a role's memory (asks for confirmation unless --force)",
    );
  addRoleOptions(cmd);
  addCompanyOptions(cmd);
  cmd
    .requiredOption('--id <memoryId>', 'Memory id')
    .option('-f, --force', 'Skip the confirmation prompt');
  cmd.action(
    (cmdOpts: {
      role?: string;
      roleId?: string;
      roleSlug?: string;
      company?: string;
      companyId?: string;
      companySlug?: string;
      id: string;
      force?: boolean;
    }) => deleteMemoryAction(getGlobalOptions(program), cmdOpts),
  );
}
