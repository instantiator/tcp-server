import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { startTaskAction } from '../lib/tasks/task.action';

/** Starts an unstarted task (equivalent to `create-task --start`, after the fact). */
export function registerStartTask(program: Command): void {
  program
    .command('start-task')
    .description('Start a task that has not yet been started')
    .requiredOption('--task-id <uuid>', 'Task UUID')
    .action((cmdOpts: { taskId: string }) =>
      startTaskAction(getGlobalOptions(program), cmdOpts),
    );
}
