import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { getTaskAction } from '../lib/tasks/task.action';

/** Retrieves a task, including its assignment statuses and QA outcomes. */
export function registerGetTask(program: Command): void {
  program
    .command('get-task')
    .description('Get a task by ID, including its assignments')
    .requiredOption('--task-id <uuid>', 'Task UUID')
    .action((cmdOpts: { taskId: string }) =>
      getTaskAction(getGlobalOptions(program), cmdOpts),
    );
}
