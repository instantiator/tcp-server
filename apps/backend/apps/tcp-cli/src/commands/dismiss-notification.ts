import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { dismissNotificationAction } from '../lib/spend/spend.action';

/** Dismisses a notification for every user. */
export function registerDismissNotification(program: Command): void {
  program
    .command('dismiss-notification')
    .description('Dismiss a notification')
    .requiredOption('--notification-id <uuid>', 'Notification UUID')
    .action((cmdOpts: { notificationId: string }) =>
      dismissNotificationAction(getGlobalOptions(program), cmdOpts),
    );
}
