import { printAndMaybeOpen } from './open-url';

/**
 * Prints the MinIO console URL and optionally opens it in the default browser.
 *
 * The URL is read from `MINIO_CONSOLE_URL` in the process environment,
 * defaulting to `http://localhost:9001`.
 *
 * stdout: the console URL.
 */
export function openDocumentStoreAction(cmdOpts: { open: boolean }): void {
  const url = process.env['MINIO_CONSOLE_URL'] ?? 'http://localhost:9001';
  printAndMaybeOpen(url, cmdOpts.open);
}
