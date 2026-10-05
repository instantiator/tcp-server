import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { restoreCapAction } from '../lib/spend/spend.action';

/** Restores a dismissed spend cap, re-evaluating it straight away (administrators only). */
export function registerRestoreCap(program: Command): void {
  program
    .command('restore-cap')
    .description("Restore a provider's spend cap (administrators only)")
    .requiredOption('--provider <id>', 'Catalogue provider id')
    .action((cmdOpts: { provider: string }) =>
      restoreCapAction(getGlobalOptions(program), cmdOpts),
    );
}
