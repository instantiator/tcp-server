import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { addCompanyOptions, addRoleOptions } from '../lib/core/entity-ref';
import {
  listAgentsAction,
  ListAgentsCmdOpts,
} from '../lib/observability/list-agents.action';

/** Registers the `list-agents` command. */
export function registerListAgents(program: Command): void {
  const cmd = program
    .command('list-agents')
    .description('List agents for a role or company');
  addRoleOptions(cmd);
  addCompanyOptions(cmd);
  cmd
    .option(
      '--filter <key=value>',
      'Filter: status=<status> (default: active), role=<slug-or-id>, assignment=<id> — repeatable',
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .action((cmdOpts: ListAgentsCmdOpts) =>
      listAgentsAction(getGlobalOptions(program), cmdOpts),
    );
}
