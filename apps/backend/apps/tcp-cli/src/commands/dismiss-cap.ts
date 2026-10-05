import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { dismissCapAction } from '../lib/spend/spend.action';

/** Lifts a provider's spend cap, until its next reset or indefinitely (administrators only). */
export function registerDismissCap(program: Command): void {
  program
    .command('dismiss-cap')
    .description(
      "Lift a provider's spend cap until reset or indefinitely (administrators only)",
    )
    .requiredOption('--provider <id>', 'Catalogue provider id')
    .option(
      '--indefinitely',
      'Lift the cap until restored, instead of until its next reset',
    )
    .action((cmdOpts: { provider: string; indefinitely?: boolean }) =>
      dismissCapAction(getGlobalOptions(program), cmdOpts),
    );
}
