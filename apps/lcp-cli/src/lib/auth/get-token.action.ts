import { GlobalOptions } from '../core/cli-options';
import { runCommand } from '../core/run-command';
import { resolveToken } from './token';

/** Fetches an OIDC access token and writes it to stdout. */
export function getTokenAction(opts: GlobalOptions): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
    process.stdout.write(token + '\n');
  });
}
