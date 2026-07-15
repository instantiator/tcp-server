import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { addEntityIdOptions } from '../lib/core/entity-ref';
import { createTaskAction } from '../lib/tasks/task.action';

/**
 * Creates a task, optionally uploading materials and starting it in one call.
 */
export function registerCreateTask(program: Command): void {
  const cmd = program.command('create-task').description('Create a task');
  addEntityIdOptions(cmd, {
    flag: 'company',
    short: 'c',
    label: 'Company',
    required: true,
  });
  cmd.requiredOption(
    '-r, --request <text>',
    "The user's statement of the work",
  );
  // No short flag: -r is already --request on this verb.
  addEntityIdOptions(cmd, { flag: 'planner-role', label: 'Planner role' });
  cmd
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
        plannerRoleId?: string;
        plannerRoleSlug?: string;
        materials?: string[];
        expected?: string[];
        start?: boolean;
      }) => createTaskAction(getGlobalOptions(program), cmdOpts),
    );
}
