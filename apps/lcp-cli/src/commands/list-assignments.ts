import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { addCompanyOptions } from '../lib/core/entity-ref';
import {
  listAssignmentsAction,
  ListAssignmentsCmdOpts,
} from '../lib/observability/list-assignments.action';

/** Registers the `list-assignments` command. */
export function registerListAssignments(program: Command): void {
  const cmd = program
    .command('list-assignments')
    .description('List assignments for a task or company')
    .option('--task-id <uuid>', 'Task UUID');
  addCompanyOptions(cmd);
  cmd
    .option(
      '--filter <key=value>',
      'Filter: status=<status>, task=<task-id>, task=null (orphans), role=<slug-or-id> — repeatable',
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .action((cmdOpts: ListAssignmentsCmdOpts) =>
      listAssignmentsAction(getGlobalOptions(program), cmdOpts),
    );
}
