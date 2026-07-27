import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { respondAction } from '../lib/queries/respond.action';

/**
 * Posts a reply to an open agent query conversation, closing it and
 * triggering agent resume if the conversation was linked to a paused agent.
 */
export function registerRespond(program: Command): void {
  program
    .command('respond <slug> <message>')
    .description(
      'Reply to an open agent query (closes the conversation and resumes the agent)',
    )
    .option(
      '-i, --identifier <id>',
      'Your identifier (e.g. email), included in the message record',
    )
    .action((slug: string, message: string, cmdOpts: { identifier?: string }) =>
      respondAction(getGlobalOptions(program), slug, message, cmdOpts),
    );
}
