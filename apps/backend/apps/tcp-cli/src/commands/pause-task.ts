import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { pauseTaskAction } from '../lib/tasks/task.action';

/**
 * Pauses a running task. Its agents stop after their current step, and stay
 * paused until `resume-task`.
 */
export function registerPauseTask(program: Command): void {
  program
    .command('pause-task')
    .description(
      'Pause a running task; its agents stop after their current step until resume-task',
    )
    .requiredOption('--task-id <uuid>', 'Task UUID')
    .action((cmdOpts: { taskId: string }) =>
      pauseTaskAction(getGlobalOptions(program), cmdOpts),
    );
}
