import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { resumeTaskAction } from '../lib/spend/spend.action';

/**
 * Resumes work paused by a spend cap or a shutdown, and exempts the task
 * from spend caps until it finishes.
 */
export function registerResumeTask(program: Command): void {
  program
    .command('resume-task')
    .description(
      'Resume a task paused by a spend cap or shutdown, exempting it from spend caps until it finishes',
    )
    .requiredOption('--task-id <uuid>', 'Task UUID')
    .action((cmdOpts: { taskId: string }) =>
      resumeTaskAction(getGlobalOptions(program), cmdOpts),
    );
}
