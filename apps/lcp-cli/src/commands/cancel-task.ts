import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { cancelTaskAction } from '../lib/tasks/task.action';

/** Cancels a task, and its still-non-terminal assignments and agents. */
export function registerCancelTask(program: Command): void {
  program
    .command('cancel-task')
    .description('Cancel a task')
    .requiredOption('--task-id <uuid>', 'Task UUID')
    .action((cmdOpts: { taskId: string }) =>
      cancelTaskAction(getGlobalOptions(program), cmdOpts),
    );
}
