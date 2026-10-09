import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { resumeTaskAction } from '../lib/spend/spend.action';

/**
 * Resumes a paused task: a user's pause, or agents paused by a spend cap, a
 * shutdown or a rate limit. Exempts the task from spend caps only while one
 * is reached.
 */
export function registerResumeTask(program: Command): void {
  program
    .command('resume-task')
    .description(
      'Resume a paused task (a pause-task, spend cap, shutdown or rate limit); exempts it from spend caps only while one is reached',
    )
    .requiredOption('--task-id <uuid>', 'Task UUID')
    .action((cmdOpts: { taskId: string }) =>
      resumeTaskAction(getGlobalOptions(program), cmdOpts),
    );
}
