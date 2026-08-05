import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { addCompanyOptions } from '../lib/core/entity-ref';
import { listTasksAction } from '../lib/tasks/task.action';

/** Lists tasks for a company. */
export function registerListTasks(program: Command): void {
  const cmd = program
    .command('list-tasks')
    .description('List tasks for a company');
  addCompanyOptions(cmd, { required: true });
  cmd.action(
    (cmdOpts: { company?: string; companyId?: string; companySlug?: string }) =>
      listTasksAction(getGlobalOptions(program), cmdOpts),
  );
}
