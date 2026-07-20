import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { getTokenAction } from '../lib/auth/get-token.action';

interface GetTokenOptions {
  force?: boolean;
}

/** Registers the `get-token` command. */
export function registerGetToken(program: Command): void {
  program
    .command('get-token')
    .description(
      'Sign in via the browser (device flow) and print an OIDC access token',
    )
    .option('-f, --force', 'Skip cached token and always re-authenticate')
    .action((cmdOpts: GetTokenOptions) =>
      getTokenAction(getGlobalOptions(program), cmdOpts),
    );
}
