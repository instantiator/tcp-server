import { execSync } from 'child_process';
import { Command } from 'commander';

/**
 * Prints the MinIO console URL and optionally opens it in the default browser.
 *
 * The URL is read from `MINIO_CONSOLE_URL` in the process environment,
 * defaulting to `http://localhost:9001`.
 *
 * stdout: the console URL.
 */
export function registerOpenDocumentStore(program: Command): void {
  program
    .command('open-document-store')
    .description('Print (and optionally open) the MinIO document store console')
    .option('--no-open', 'Print the URL without opening the browser')
    .action((cmdOpts: { open: boolean }) => {
      const url = process.env['MINIO_CONSOLE_URL'] ?? 'http://localhost:9001';

      process.stdout.write(url + '\n');

      if (!cmdOpts.open) return;

      const opener =
        process.platform === 'darwin'
          ? 'open'
          : process.platform === 'win32'
            ? 'start'
            : 'xdg-open';
      try {
        execSync(`${opener} "${url}"`, { stdio: 'ignore' });
      } catch {
        // Non-fatal: URL was already printed, user can open manually
      }
    });
}
