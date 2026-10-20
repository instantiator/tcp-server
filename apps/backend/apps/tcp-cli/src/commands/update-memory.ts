import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { addCompanyOptions, addRoleOptions } from '../lib/core/entity-ref';
import { updateMemoryAction } from '../lib/memory/update-memory.action';

/** Updates a role's memory; only the fields given change. */
export function registerUpdateMemory(program: Command): void {
  const cmd = program
    .command('update-memory')
    .description("Update a role's memory (content, tags, or both)");
  addRoleOptions(cmd);
  addCompanyOptions(cmd);
  cmd
    .requiredOption('--id <memoryId>', 'Memory id')
    .option('-c, --content <text>', 'New memory text')
    .option('-t, --tags <a,b>', 'New comma-separated tags (replaces existing)');
  cmd.action(
    (cmdOpts: {
      role?: string;
      roleId?: string;
      roleSlug?: string;
      company?: string;
      companyId?: string;
      companySlug?: string;
      id: string;
      content?: string;
      tags?: string;
    }) => updateMemoryAction(getGlobalOptions(program), cmdOpts),
  );
}
