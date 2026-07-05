import * as readline from 'readline';
import { Tui } from '../tui/tui';
import { ChatSession } from './session';

/**
 * `--query` mode: runs the single turn, then always tears down the TUI (if
 * any) and cleans up every agent created this session, whether the turn
 * succeeded or not.
 */
export async function runOneShotQuery(
  session: ChatSession,
  tui: Tui | null,
  rootAgentId: string,
  query: string,
): Promise<void> {
  if (!tui) process.stderr.write('Sending...\n');
  try {
    await session.runTurn(rootAgentId, query, false);
  } finally {
    tui?.stop();
    await session.cleanup();
  }
}

/**
 * Wires the full-screen TUI's input/quit/roster events to the session and
 * waits for the user to quit. The TUI's InlineInput replaces readline
 * entirely; Ctrl+C is a raw key event delivered via grabInput (not a SIGINT
 * signal), so the two-stage quit semantics are wired through `Tui.onQuit`
 * instead of `process.on('SIGINT', ...)`.
 */
export async function runTuiInteractive(
  session: ChatSession,
  tui: Tui,
): Promise<void> {
  let resolveQuit!: () => void;
  const quit = new Promise<void>((r) => (resolveQuit = r));

  tui.onQuit(() => {
    if (session.hasInFlightTurns) {
      session.abortAllTurns();
    } else {
      tui.stop();
      resolveQuit();
    }
  });

  tui.onSubmit((message, paneId) => {
    if (session.isBusy(paneId)) return; // turn already in flight on this pane
    const trimmed = message.trim();
    if (!trimmed || trimmed === 'exit' || trimmed === 'quit') {
      tui.stop();
      resolveQuit();
      return;
    }
    void session.runTurn(paneId, trimmed, true);
  });

  tui.onSelectRole((role) => {
    void session
      .startAgentPane(role.id, role.name, true)
      .then((id) => tui.switchToPane(id))
      .catch((err) => session.reportRosterError(err));
  });

  tui.onRefreshRoster(() => {
    void session
      .fetchRoles()
      .then((roles) => tui.updateRosterRoles(session.companyId, roles))
      .catch((err) => session.reportRosterError(err));
  });

  await quit;
  await session.cleanup();
}

/**
 * Plain readline loop (no TUI) — two-stage SIGINT: during a turn, stop
 * watching (the agent continues server-side); at the idle prompt, clean up
 * and exit. `--company-id` without `--role-id` is rejected before this mode
 * can ever be reached (there's no roster to browse without the TUI), so
 * `rootAgentId` is always a real agent here.
 */
export async function runReadlineInteractive(
  session: ChatSession,
  rootAgentId: string,
): Promise<void> {
  process.on('SIGINT', () => {
    if (session.hasInFlightTurns) {
      session.abortAllTurns();
      process.stderr.write(
        '\nStopped watching (the agent continues on the server).\n',
      );
    } else {
      void session.cleanup().then(() => process.exit(0));
    }
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
    prompt: '> ',
  });
  // stdin may reach EOF (piped input) while a turn is awaited; guard the
  // re-prompt so it never fires after the interface has closed.
  let rlClosed = false;
  rl.on('close', () => {
    rlClosed = true;
  });

  rl.prompt();
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === 'exit' || trimmed === 'quit') break;
    await session.runTurn(rootAgentId, trimmed, true);
    // Exactly one prompt per turn, after all streams have closed — this is
    // what removes the stray extra '>' the old timer-based loop produced.
    if (!rlClosed) rl.prompt();
  }

  if (!rlClosed) rl.close();
  await session.cleanup();
}
