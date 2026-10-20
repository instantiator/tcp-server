import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { addCompanyOptions, addRoleOptions } from '../lib/core/entity-ref';
import { addMemoryAction } from '../lib/memory/add-memory.action';

/** Adds a memory to a role, with optional tags. */
export function registerAddMemory(program: Command): void {
  const cmd = program
    .command('add-memory')
    .description('Add a memory to a role');
  addRoleOptions(cmd);
  addCompanyOptions(cmd);
  cmd
    .requiredOption(
      '-c, --content <text>',
      'Memory text (max 2,000 characters)',
    )
    .option('-t, --tags <a,b>', 'Comma-separated tags');
  cmd.action(
    (cmdOpts: {
      role?: string;
      roleId?: string;
      roleSlug?: string;
      company?: string;
      companyId?: string;
      companySlug?: string;
      content: string;
      tags?: string;
    }) => addMemoryAction(getGlobalOptions(program), cmdOpts),
  );
}
