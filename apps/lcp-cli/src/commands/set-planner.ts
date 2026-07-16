import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import {
  addCompanyOptions,
  addRoleOptions,
  EntityRefOpts,
} from '../lib/core/entity-ref';
import { setPlannerAction } from '../lib/tasks/task.action';

/**
 * Registers the `set-planner` command: sets a company's or an unstarted
 * task's planner role. Exactly one of a company target or `--task-id` must
 * be given.
 */
export function registerSetPlanner(program: Command): void {
  const cmd = program
    .command('set-planner')
    .description("Set a company's or an unstarted task's planner role");
  addCompanyOptions(cmd);
  addRoleOptions(cmd, { required: true });
  cmd
    .option('--task-id <uuid>', 'Task UUID, instead of a company target')
    .action((cmdOpts: EntityRefOpts & { taskId?: string }) =>
      setPlannerAction(getGlobalOptions(program), cmdOpts),
    );
}
