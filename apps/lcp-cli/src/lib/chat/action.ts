import { GlobalOptions } from '../core/cli-options';
import { Tui } from '../tui/tui';
import { shouldUseTui, validateChatFlags } from './flags';
import { resolveChatContext } from './context';
import { ChatSession } from './session';
import {
  runOneShotQuery,
  runReadlineInteractive,
  runTuiInteractive,
} from './wiring';

export interface ChatCmdOpts {
  roleId?: string;
  companyId?: string;
  query?: string;
  hideReasoning?: boolean;
  tui?: boolean;
}

/**
 * Top-level orchestrator for the `chat` command.
 *
 * Initiates a conversation with an agent running the specified role, or (with
 * `--company-id` instead of `--role-id`) opens the TUI on that company's
 * roster pane with no agent started yet — pick a role there (Up/Down, Enter)
 * to start chatting. Every chat session's agents are deleted when it ends.
 *
 * Single-query mode (-q, requires --role-id): creates the agent, sends one
 * message, streams the response to stderr while printing the final answer to
 * stdout, then deletes the agent. Interactive mode: enters a readline loop
 * (or the TUI's input box); agents are deleted on exit or Ctrl+C.
 *
 * Each turn returns `202 Accepted`; all output (agent state, LLM activity,
 * reasoning, response, and completion) arrives on the agent's SSE event
 * stream (`GET /api/agent/:id/events`). When an agent pauses to consult
 * another agent, the CLI follows the consulted agent's stream too.
 *
 * When stdout is a real TTY (and `--no-tui` wasn't passed), a full-screen TUI
 * (see `../tui/tui.ts`) replaces the linear stdout/stderr rendering: pane 0
 * is always the company roster (its roles, Enter to start a chat, 'r' to
 * refresh); with `--role-id`, a talkable pane for that agent opens
 * immediately alongside it and becomes active. Each consultation followed
 * and each role chatted with via the roster gets its own tab. `--query` at a
 * TTY also uses the TUI: the query is submitted automatically, and the TUI
 * tears down as soon as the root agent's turn reaches its terminal event.
 * When stdout is not a TTY, or `--no-tui` is passed, the linear renderer is
 * used unchanged — see `../core/render.ts`.
 */
export async function chatAction(
  opts: GlobalOptions,
  cmdOpts: ChatCmdOpts,
): Promise<void> {
  const useTui = shouldUseTui(cmdOpts, Boolean(process.stdout.isTTY));
  const flagError = validateChatFlags(cmdOpts, useTui);
  if (flagError) {
    process.stderr.write(`Error: ${flagError}\n`);
    process.exit(1);
  }

  const hideReasoning = cmdOpts.hideReasoning ?? false;
  let tui: Tui | null = null;
  let session: ChatSession;
  let rootAgentId: string | undefined;

  try {
    const context = await resolveChatContext(opts, cmdOpts, useTui);
    // Constructed after the banner above prints, so it's briefly visible
    // in normal scrollback before the screen switches to the TUI.
    tui = useTui ? new Tui({ hideReasoning }) : null;
    session = new ChatSession(
      opts,
      context.companyId,
      hideReasoning,
      tui,
      context,
    );

    if (tui) {
      const roles = await session.fetchRoles();
      tui.addRosterPane({
        id: context.companyId,
        label: context.companyName,
        roles,
      });
    }
    if (cmdOpts.roleId) {
      rootAgentId = await session.startAgentPane(
        cmdOpts.roleId,
        context.roleName,
        !cmdOpts.query,
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
