import { GlobalOptions } from '../core/cli-options';
import { runCommand } from '../core/run-command';
import { resolveToken } from './token';

interface GetTokenOptions {
  force?: boolean;
}

/** Fetches an OIDC access token and writes it to stdout. */
export function getTokenAction(
  opts: GlobalOptions,
  cmdOpts?: GetTokenOptions,
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({
      ...opts,
      baseUrl: opts.lcpServer,
      force: cmdOpts?.force,
    });
    process.stdout.write(token + '\n');
  });
}
