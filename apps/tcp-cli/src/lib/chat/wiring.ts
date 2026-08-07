import * as readline from 'readline';
import { Tui } from '../tui/tui';
import { ChatSession } from './session';

/**
 * `--query` mode: answer a single question given on the command line.
 *
 * Without a TUI (piped output, or `--no-tui`) this is fully one-shot — run the
 * turn, print the final answer to stdout, clean up, and exit. That is the
 * classic pipeable behaviour.
 *
 * With the TUI, the query is just the first message of an otherwise normal
 * interactive session: it renders into the root pane like any other turn, and
 * the TUI stays open afterwards so the response isn't lost the instant it
 * arrives. The user can keep chatting, switch tabs, or quit when they're done.
 */
export async function runOneShotQuery(
  session: ChatSession,
  tui: Tui | null,
  rootAgentId: string,
  query: string,
): Promise<void> {
  if (!tui) {
    process.stderr.write('Sending...\n');
    try {
      await session.runTurn(rootAgentId, query, false);
    } finally {
      await session.cleanup();
    }
    return;
  }

  await session.runTurn(rootAgentId, query, true);
  await runTuiInteractive(session, tui);
}

/**
 * Wires the full-screen TUI's events to the session, then waits for the user
 * to quit.
 *
 * The TUI's {@link Tui} InlineInput replaces readline entirely, so there is no
 * prompt loop here — every interaction arrives as one of the callbacks
 * registered below.
 *
 * NB. Ctrl+C reaches the TUI as a raw key event (via `grabInput`), never as a
 * SIGINT signal, so quitting is wired through {@link Tui.onQuit} rather than
 * `process.on('SIGINT', ...)`. It quits in two stages:
 * 1. While a turn is in flight, abort the turn (the agent continues
 *    server-side).
 * 2. While idle, stop the TUI and end the session.
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
      .startAssignmentPane(role.id, role.slug, role.name, true)
      .then((id) => tui.switchToPane(id))
      .catch((err) => session.reportPaneError(session.companyId, err));
  });

  tui.onRefreshRoster(() => {
    void Promise.all([session.fetchRoles(), session.fetchTasks()])
      .then(([roles, tasks]) => {
        tui.updateRosterRoles(session.companyId, roles);
        tui.updateRosterTasks(session.companyId, tasks);
      })
      .catch((err) => session.reportPaneError(session.companyId, err));
  });

  tui.onSelectTask((task) => {
    void session
      .fetchTaskDetail(task.id)
      .then(({ task: detail, assignments }) => {
        tui.addTaskPane({
          id: detail.id,
          label: `Task: ${detail.shortcode}`,
          prompt: detail.request,
          status: detail.status,
          assignments,
        });
        tui.switchToPane(detail.id);
        session.watchTaskEvents(detail.id);
      })
      .catch((err) => session.reportPaneError(session.companyId, err));
  });

  tui.onOpenInitiateTask(() => {
    void Promise.all([
      session.fetchRoles(),
      session.fetchCompanyDefaultPlannerRoleId(),
    ])
      .then(([roles, defaultRoleId]) => {
        tui.addInitiateTaskPane({
          companyId: session.companyId,
          roles,
          defaultRoleId,
        });
      })
      .catch((err) => session.reportPaneError(session.companyId, err));
  });

  tui.onSubmitInitiateTask((paneId, submission) => {
    void session
      .createTask(submission)
      .then(({ task, assignments }) => {
        tui.replaceWithTaskPane(paneId, {
          id: task.id,
          label: `Task: ${task.shortcode}`,
          prompt: task.request,
          status: task.status,
          assignments,
        });
        session.watchTaskEvents(task.id);
      })
      .catch((err) => session.reportPaneError(paneId, err));
  });

  tui.onSelectAssignment((_taskId, assignment) => {
    void session
      .openAssignmentChatPane(assignment)
      .catch((err) => session.reportPaneError(session.companyId, err));
  });

  tui.onCancelTask((taskId) => {
    void session.cancelTask(taskId);
  });

  tui.onStartTask((taskId) => {
    void session.startTask(taskId);
  });

  tui.onCloseTab((paneId) => {
    void session.closeTab(paneId);
  });

  await quit;
  await session.cleanup();
}

/**
 * Plain readline loop (no TUI).
 *
 * Handles SIGINT in two stages:
 * 1. During a turn, stop watching (the agent continues server-side).
 * 2. At the idle prompt, clean up and exit.
 *
 * NB. `--company-id` without `--role-id` is rejected before this mode can ever
 * be reached (there's no roster to browse without the TUI), so `rootAgentId`
 * is guaranteed to be a real agent here.
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
