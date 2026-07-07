/** Prints a single warning line to stderr in yellow, prefixed with a warning emoji. */
export function printWarning(message: string): void {
  process.stderr.write(`\x1b[33m⚠️  ${message}\x1b[0m\n`);
}
