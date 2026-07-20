import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { setTaskAction } from '../lib/tasks/task.action';

/** Registers the `set-task` command. */
export function registerSetTask(program: Command): void {
  program
    .command('set-task')
    .description('Edit an unstarted task (reads JSON from --input or stdin)')
    .requiredOption('--task-id <uuid>', 'Task UUID')
    .option('-i, --input <json>', 'Task JSON (DeepPartial<LcpTask>)')
    .action((cmdOpts: { taskId: string; input?: string }) =>
      setTaskAction(getGlobalOptions(program), cmdOpts),
    );
}
