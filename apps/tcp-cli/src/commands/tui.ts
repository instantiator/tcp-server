import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { addCompanyOptions } from '../lib/core/entity-ref';
import { tuiAction, TuiCmdOpts } from '../lib/chat/action';

/**
 * Registers the `tui` command. See {@link tuiAction} (`../lib/chat/action.ts`)
 * for the full behaviour, and `docs/tcp-cli.md#tui` for user-facing docs.
 */
export function registerTui(program: Command): void {
  const cmd = program
    .command('tui')
    .description(
      "Open the full-screen TUI on a company's roster (no role required)",
    );
  addCompanyOptions(cmd, { required: true });
  cmd
    .option('--hide-reasoning', 'Hide the model reasoning stream')
    .option(
      '--task-list-max-lines <n>',
      'Max lines a highlighted company task-list entry expands to ' +
        '(default 4; env LCP_TASK_LIST_ENTRY_MAX_LINES)',
    )
    .action((cmdOpts: TuiCmdOpts) =>
      tuiAction(getGlobalOptions(program), cmdOpts),
    );
}
