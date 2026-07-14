import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { createTaskAction } from '../lib/tasks/task.action';

/**
 * Creates a task, optionally uploading materials and starting it in one call.
 */
export function registerCreateTask(program: Command): void {
  program
    .command('create-task')
    .description('Create a task')
    .requiredOption('-c, --company <slug-or-id>', 'Company slug or UUID')
    .requiredOption('-r, --request <text>', "The user's statement of the work")
    .option('--planner-role <slug-or-id>', 'Planner role slug or UUID')
    .option('-m, --materials <paths...>', 'Local material file paths to upload')
    .option(
      '--expected <filenames...>',
      'Filenames expected in the task completed directory',
    )
    .option('--start', 'Start the task immediately after creation')
    .action(
      (cmdOpts: {
        company: string;
        request: string;
        plannerRole?: string;
        materials?: string[];
        expected?: string[];
        start?: boolean;
      }) => createTaskAction(getGlobalOptions(program), cmdOpts),
    );
}
