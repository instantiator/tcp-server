import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { notificationsAction } from '../lib/spend/spend.action';

/** Lists application-wide notifications; `--all` includes dismissed ones. */
export function registerNotifications(program: Command): void {
  program
    .command('notifications')
    .description('List application-wide notifications')
    .option('--all', 'Include already-dismissed notifications')
    .action((cmdOpts: { all?: boolean }) =>
      notificationsAction(getGlobalOptions(program), cmdOpts),
    );
}
