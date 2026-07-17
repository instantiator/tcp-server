import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import {
  eavesdropAction,
  EavesdropCmdOpts,
} from '../lib/observability/eavesdrop.action';

/** Registers the `eavesdrop` command. */
export function registerEavesdrop(program: Command): void {
  program
    .command('eavesdrop')
    .description(
      'Watch (or replay the history of) an agent, assignment, or task',
    )
    .option('--agent-id <uuid>', 'Agent UUID to eavesdrop on')
    .option('--assignment-id <uuid>', 'Assignment UUID to eavesdrop on')
    .option('--task-id <uuid>', 'Task UUID to eavesdrop on')
    .option(
      '--show-history',
      'Reconstruct and print past events from the audit log',
    )
    .option('--tail', 'Follow current events live')
    .action((cmdOpts: EavesdropCmdOpts) =>
      eavesdropAction(getGlobalOptions(program), cmdOpts),
    );
}
