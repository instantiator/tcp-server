import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { addCompanyOptions, addRoleOptions } from '../lib/core/entity-ref';
import { chatAction, ChatCmdOpts } from '../lib/chat/action';

/**
 * Registers the `chat` command. See {@link chatAction} (`../lib/chat/action.ts`)
 * for the full behaviour, and `docs/tcp-cli.md#chat` for user-facing docs.
 */
export function registerChat(program: Command): void {
  const cmd = program
    .command('chat')
    .description('Start an interactive chat session with an agent');
  addRoleOptions(cmd);
  addCompanyOptions(cmd);
  cmd
    .option('-q, --query <message>', 'Single query (non-interactive)')
    .option('--hide-reasoning', 'Hide the model reasoning stream')
    .option('--no-tui', 'Disable the full-screen TUI even on a TTY')
    .option(
      '--task-list-max-lines <n>',
      'Max lines a highlighted company task-list entry expands to ' +
        '(default 4; env TCP_TASK_LIST_ENTRY_MAX_LINES)',
    )
    .action((cmdOpts: ChatCmdOpts) =>
      chatAction(getGlobalOptions(program), cmdOpts),
    );
}
