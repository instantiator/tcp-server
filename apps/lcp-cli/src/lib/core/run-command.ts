/**
 * Runs a command action, writing `Error: <message>` to stderr and exiting
 * with status 1 if it throws — the uniform failure behaviour every lcp-cli
 * command uses instead of repeating its own try/catch.
 */
export async function runCommand(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    process.stderr.write(
      `Error: ${String(err instanceof Error ? err.message : err)}\n`,
    );
    process.exit(1);
  }
}
