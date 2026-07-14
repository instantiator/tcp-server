import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { chatAction, ChatCmdOpts } from '../lib/chat/action';

/**
 * Registers the `chat` command. See {@link chatAction} (`../lib/chat/action.ts`)
 * for the full behaviour, and `docs/lcp-cli.md#chat` for user-facing docs.
 */
export function registerChat(program: Command): void {
  program
    .command('chat')
    .description('Start an interactive chat session with an agent')
    .option(
      '-r, --role-id <uuid>',
      'Role UUID for the agent (omit to browse company roles instead)',
    )
    .option(
      '--role-slug <slug>',
      'Role slug instead of --role-id (requires --company-id or --company-slug — role slugs are only unique within a company)',
    )
    .option(
      '-c, --company-id <uuid>',
      'Company UUID — browse and start chats from its role roster (requires a TTY)',
    )
    .option('--company-slug <slug>', 'Company slug instead of --company-id')
    .option('-q, --query <message>', 'Single query (non-interactive)')
    .option('--hide-reasoning', 'Hide the model reasoning stream')
    .option('--no-tui', 'Disable the full-screen TUI even on a TTY')
    .action((cmdOpts: ChatCmdOpts) =>
      chatAction(getGlobalOptions(program), cmdOpts),
    );
}
