import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { notificationsAction } from '../lib/spend/spend.action';

/**
 * Lists application-wide notifications, plus one company's own (its task
 * notices) with `--company-id`; `--all` includes dismissed ones.
 */
export function registerNotifications(program: Command): void {
  program
    .command('notifications')
    .description(
      "List application-wide notifications, plus a company's own with --company-id",
    )
    .option('--all', 'Include already-dismissed notifications')
    .option(
      '--company-id <uuid>',
      "Also list this company's own notices (task failures, shutdown pauses)",
    )
    .action((cmdOpts: { all?: boolean; companyId?: string }) =>
      notificationsAction(getGlobalOptions(program), cmdOpts),
    );
}
