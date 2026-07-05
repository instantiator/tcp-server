import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { getTokenAction } from '../lib/auth/get-token.action';

/** Registers the `get-token` command. */
export function registerGetToken(program: Command): void {
  program
    .command('get-token')
    .description('Exchange username + password for an OIDC access token')
    .action(() => getTokenAction(getGlobalOptions(program)));
}
