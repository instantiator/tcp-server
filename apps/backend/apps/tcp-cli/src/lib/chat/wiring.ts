import * as readline from 'readline';
import { ChatSession } from './session';

/**
 * `--query` mode: answer a single question given on the command line. Fully
 * one-shot — runs the turn (progress on stderr), prints the final answer to
 * stdout, cleans up, and exits, so it stays pipeable.
 */
export async function runOneShotQuery(
  session: ChatSession,
  rootAgentId: string,
  query: string,
): Promise<void> {
  process.stderr.write('Sending...\n');
  try {
    await session.runTurn(rootAgentId, query, false);
  } finally {
    await session.cleanup();
  }
}

/**
 * Plain readline loop.
 *
 * Handles SIGINT in two stages:
 * 1. During a turn, stop watching (the agent continues server-side).
 * 2. At the idle prompt, clean up and exit.
 *
 * NB. `chat` without a role is rejected before this loop can ever be reached,
 * so `rootAgentId` is guaranteed to be a real agent here.
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
