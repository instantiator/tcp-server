import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { getHealthAction } from '../lib/system/health.action';

/** Shows whether each service is up (administrators only). */
export function registerGetHealth(program: Command): void {
  program
    .command('get-health')
    .description('Show the health of every service')
    .option('--app <name>', 'Show only this service, e.g. tcp-agent')
    .action((cmdOpts: { app?: string }) =>
      getHealthAction(getGlobalOptions(program), cmdOpts),
    );
}
