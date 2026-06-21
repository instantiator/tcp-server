import { Command } from 'commander';
import { resolveToken, AuthOptions } from '../lib/auth';

/** Fetches an OIDC access token and writes it to stdout. */
export function registerGetToken(program: Command): void {
  program
    .command('get-token')
    .description('Exchange username + password for an OIDC access token')
    .action(async () => {
      const opts = program.opts<AuthOptions & { lcpServer: string }>();
      if (!opts.username) {
        process.stderr.write('Error: --username is required for get-token\n');
        process.exit(1);
      }
      try {
        const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
        process.stdout.write(token + '\n');
      } catch (err) {
        process.stderr.write(
          `Error: ${String(err instanceof Error ? err.message : err)}\n`,
        );
        process.exit(1);
      }
    });
}
