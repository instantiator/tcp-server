import { EntityRefOpts } from '../core/entity-ref';
import { GlobalOptions } from '../core/cli-options';
import { resolveTaskListEntryMaxLines, Tui } from '../tui/tui';
import { shouldUseTui, validateChatFlags } from './flags';
import { ChatContext, resolveChatContext } from './context';
import { ChatSession } from './session';
import {
  runOneShotQuery,
  runReadlineInteractive,
  runTuiInteractive,
} from './wiring';

export interface ChatCmdOpts extends EntityRefOpts {
  query?: string;
  hideReasoning?: boolean;
  tui?: boolean;
  taskListMaxLines?: string;
}

export interface TuiCmdOpts extends EntityRefOpts {
  hideReasoning?: boolean;
  taskListMaxLines?: string;
}

/**
 * Constructs the TUI and opens it on the company roster pane (roles, Enter
 * to start a chat, 'r' to refresh, 'n' to initiate a task) with no agent
 * pane started yet — shared by `chatAction`'s TUI path (which then adds a
 * talkable pane for the given role alongside it) and `tuiAction` (the
 * dedicated `tui` verb, which stops here).
 */
async function openRosterTui(
  opts: GlobalOptions,
  context: ChatContext,
  hideReasoning: boolean,
  taskListEntryMaxLines: number,
): Promise<{ tui: Tui; session: ChatSession }> {
  // Constructed after the banner above prints, so it's briefly visible in
  // normal scrollback before the screen switches to the TUI.
  const tui = new Tui({ hideReasoning, taskListEntryMaxLines });
  const session = new ChatSession(
    opts,
    context.companyId,
    hideReasoning,
    tui,
    context,
  );
  const roles = await session.fetchRoles();
  tui.addRosterPane({
    id: context.companyId,
    label: context.companyName,
    slug: context.companySlug,
    roles,
  });
  const tasks = await session.fetchTasks();
  tui.updateRosterTasks(context.companyId, tasks);
  session.watchCompanyEvents();
  return { tui, session };
}

/**
 * Top-level orchestrator for the `chat` command.
 *
 * Initiates a conversation with an agent running the specified role
 * (`--role-id`, or `--role-slug` scoped to a company) — `chat` always means a
 * talkable session with a role; browsing a company's roster with no role
 * chosen yet is `tui <company>`'s job (see `tuiAction` below). Every chat
 * session's agents are deleted when it ends.
 *
 * Single-query mode (-q): creates the agent and sends one message. Without
 * the TUI (piped output, or `--no-tui`), this is fully one-shot: streams the
 * response to stderr, prints the final answer to stdout, deletes the agent,
 * and exits — pipeable. With the TUI, the query is just the first message of
 * an otherwise normal interactive session: it renders into the pane and the
 * TUI stays open afterward (see `wiring.ts`'s `runOneShotQuery`), so the
 * answer isn't lost the instant it arrives — same exit paths (Ctrl+C,
 * `exit`/`quit`) as any other session. Interactive mode (no -q): enters a
 * readline loop (or the TUI's input box); agents are deleted on exit or
 * Ctrl+C either way.
 *
 * Each turn returns `202 Accepted`; all output (agent state, LLM activity,
 * reasoning, response, and completion) arrives on the agent's SSE event
 * stream (`GET /api/agent/:id/events`). When an agent pauses to consult
 * another agent, the CLI follows the consulted agent's stream too.
 *
 * When stdout is a real TTY (and `--no-tui` wasn't passed), a full-screen TUI
 * (see `../tui/tui.ts`) replaces the linear stdout/stderr rendering: pane 0
 * is always the company roster (see `openRosterTui`), with a talkable pane
 * for the given role opening immediately alongside it and becoming active.
 * Each consultation followed and each role chatted with via the roster gets
 * its own tab. When stdout is not a TTY, or `--no-tui` is passed, the linear
 * renderer is used unchanged — see `../core/render.ts`.
 */
export async function chatAction(
  opts: GlobalOptions,
  cmdOpts: ChatCmdOpts,
): Promise<void> {
  const useTui = shouldUseTui(cmdOpts, Boolean(process.stdout.isTTY));
  const flagError = validateChatFlags(cmdOpts);
  if (flagError) {
    process.stderr.write(`Error: ${flagError}\n`);
    process.exit(1);
  }

  const hideReasoning = cmdOpts.hideReasoning ?? false;
  const taskListEntryMaxLines = resolveTaskListEntryMaxLines(
    cmdOpts.taskListMaxLines,
  );
  let tui: Tui | null = null;
  let session: ChatSession;
  let rootAgentId: string | undefined;

  try {
    const context = await resolveChatContext(opts, cmdOpts, useTui);
    if (useTui) {
      ({ tui, session } = await openRosterTui(
        opts,
        context,
        hideReasoning,
        taskListEntryMaxLines,
      ));
    } else {
      session = new ChatSession(
        opts,
        context.companyId,
        hideReasoning,
        null,
        context,
      );
    }
    // `chat` always resolves a role (validateChatFlags rejects a bare
    // company), so this always fires.
    if (context.roleId) {
      // Always talkable, even under --query: with the TUI, the session
      // stays open after the query's answer arrives (see runOneShotQuery),
      // so the root pane needs its input box from the start, not just
      // after the first turn finishes.
      rootAgentId = await session.startAgentPane(
        context.roleId,
        context.roleName,
        true,
      );
      if (tui) tui.switchToPane(rootAgentId);
    }
  } catch (err) {
    // tui.stop() first — a startup failure here must not leave the
    // terminal stuck in the alt screen with input still grabbed.
    tui?.stop();
    process.stderr.write(
      `Error: ${String(err instanceof Error ? err.message : err)}\n`,
    );
    process.exit(1);
  }

  if (cmdOpts.query) {
    await runOneShotQuery(session, tui, rootAgentId!, cmdOpts.query);
    return;
  }
  if (tui) {
    await runTuiInteractive(session, tui);
    return;
  }
  await runReadlineInteractive(session, rootAgentId!);
}

/**
 * Top-level orchestrator for the `tui` command: opens the full-screen TUI
 * straight onto a company's roster pane (see `openRosterTui`), with no agent
 * pane started — pick a role there (Up/Down, Enter) to start chatting, or
 * select/initiate a task. The dedicated way to browse a company without
 * committing to a role up front; `chat` always requires one.
 */
export async function tuiAction(
  opts: GlobalOptions,
  cmdOpts: TuiCmdOpts,
): Promise<void> {
  if (!process.stdout.isTTY) {
    process.stderr.write('Error: tui requires a TTY\n');
    process.exit(1);
    return;
  }

  const hideReasoning = cmdOpts.hideReasoning ?? false;
  const taskListEntryMaxLines = resolveTaskListEntryMaxLines(
    cmdOpts.taskListMaxLines,
  );
  let tui: Tui | null = null;
  let session: ChatSession;

  try {
    const context = await resolveChatContext(opts, cmdOpts, true);
    ({ tui, session } = await openRosterTui(
      opts,
      context,
      hideReasoning,
      taskListEntryMaxLines,
    ));
  } catch (err) {
    tui?.stop();
    process.stderr.write(
      `Error: ${String(err instanceof Error ? err.message : err)}\n`,
    );
    process.exit(1);
    return;
  }

  await runTuiInteractive(session, tui);
}
