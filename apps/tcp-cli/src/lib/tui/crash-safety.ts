import { Tui } from './tui';

/**
 * Installs a last-resort safety net for the life of a TUI session.
 *
 * An exception thrown from a terminal-kit event handler — a raw `EventEmitter`
 * callback several stack frames removed from any of this codebase's own
 * try/catches, e.g. a key handler driving a pane's render — would otherwise
 * crash the process without ever restoring the terminal, since only
 * {@link Tui.stop} sends the escape sequences that exit the alternate screen
 * buffer and release raw input. Left stuck, many terminal emulators then read
 * mouse-wheel scroll as arrow keys, which the shell's readline takes as
 * history navigation instead of scrolling — the "terminal looks broken after a
 * crash" symptom this closes off.
 *
 * NB. call the returned uninstall function once the session ends normally, so
 * a later, unrelated crash (a different command entirely, in the same process)
 * doesn't reach a stale handler.
 */
export function installCrashSafetyNet(tui: Tui): () => void {
  const onCrash = (err: unknown): void => {
    tui.stop();
    process.stderr.write(
      `Error: ${String(err instanceof Error ? err.message : err)}\n`,
    );
    process.exit(1);
  };
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);
  return () => {
    process.off('uncaughtException', onCrash);
    process.off('unhandledRejection', onCrash);
  };
}
