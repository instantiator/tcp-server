import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { usageAction } from '../lib/spend/spend.action';

/**
 * Reports application-wide spend caps, progress and totals; with
 * `--company-id`, adds that company's own usage.
 */
export function registerUsage(program: Command): void {
  program
    .command('usage')
    .description('Report spend caps, usage and totals')
    .option('--company-id <id-or-slug>', "Also report this company's own usage")
    .action((cmdOpts: { companyId?: string }) =>
      usageAction(getGlobalOptions(program), cmdOpts),
    );
}
