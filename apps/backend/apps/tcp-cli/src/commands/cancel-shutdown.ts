import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { cancelShutdownAction } from '../lib/system/shutdown.action';

/** Cancels a shutdown or restart in progress, so the system takes work again. */
export function registerCancelShutdown(program: Command): void {
  program
    .command('cancel-shutdown')
    .description(
      'Cancel a shutdown or restart in progress, so the system takes work again',
    )
    .action(() => cancelShutdownAction(getGlobalOptions(program)));
}
