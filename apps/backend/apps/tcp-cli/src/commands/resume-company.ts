import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { resumeCompanyAction } from '../lib/spend/spend.action';

/**
 * Resumes every task in a company paused by a spend cap or a shutdown, and
 * exempts them from spend caps until they finish.
 */
export function registerResumeCompany(program: Command): void {
  program
    .command('resume-company')
    .description(
      "Resume a company's tasks paused by a spend cap or shutdown, exempting them from spend caps until they finish",
    )
    .requiredOption('--company-id <id-or-slug>', 'Company UUID or slug')
    .action((cmdOpts: { companyId: string }) =>
      resumeCompanyAction(getGlobalOptions(program), cmdOpts),
    );
}
