import { execSync } from 'child_process';

/** Prints `url` to stdout and, unless `open` is false, opens it in the default browser. */
export function printAndMaybeOpen(url: string, open: boolean): void {
  process.stdout.write(url + '\n');
  if (!open) return;

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
}
