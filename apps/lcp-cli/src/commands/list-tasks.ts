import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { listTasksAction } from '../lib/tasks/task.action';

/** Lists tasks for a company. */
export function registerListTasks(program: Command): void {
  program
    .command('list-tasks')
    .description('List tasks for a company')
    .requiredOption('-c, --company <slug-or-id>', 'Company slug or UUID')
    .action((cmdOpts: { company: string }) =>
      listTasksAction(getGlobalOptions(program), cmdOpts),
    );
}
