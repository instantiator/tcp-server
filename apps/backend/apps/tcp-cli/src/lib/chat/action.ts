import { EntityRefOpts } from '../core/entity-ref';
import { GlobalOptions } from '../core/cli-options';
import { validateChatFlags } from './flags';
import { resolveChatContext } from './context';
import { ChatSession } from './session';
import { runOneShotQuery, runReadlineInteractive } from './wiring';

export interface ChatCmdOpts extends EntityRefOpts {
  query?: string;
  hideReasoning?: boolean;
}

/**
 * Top-level orchestrator for the `chat` command.
 *
 * Initiates a conversation with an agent running the specified role
 * (`--role-id`, or `--role-slug` scoped to a company) — `chat` always means a
 * talkable session with a role. Every chat session's agents are deleted when
 * it ends.
 *
 * Single-query mode (-q): creates the agent and sends one message, streams the
 * response to stderr, prints the final answer to stdout, deletes the agent,
 * and exits — pipeable. Interactive mode (no -q): enters a readline loop;
 * agents are deleted on exit or Ctrl+C.
 *
 * Each turn returns `202 Accepted`; all output (agent state, LLM activity,
 * reasoning, response, and completion) arrives on the agent's SSE event
 * stream (`GET /api/agent/:id/events`). When an agent pauses to consult
 * another agent, the CLI follows the consulted agent's stream too, writing it
 * to stderr. See `../core/render.ts` for the renderer.
 */
export async function chatAction(
  opts: GlobalOptions,
  cmdOpts: ChatCmdOpts,
): Promise<void> {
  const flagError = validateChatFlags(cmdOpts);
  if (flagError) {
    process.stderr.write(`Error: ${flagError}\n`);
    process.exit(1);
  }

  let session: ChatSession;
  let rootAgentId: string;

  try {
    const context = await resolveChatContext(opts, cmdOpts);
    session = new ChatSession(
      opts,
      context.companyId,
      cmdOpts.hideReasoning ?? false,
      context,
    );
    // validateChatFlags rejects a bare company, so a role is always resolved.
    rootAgentId = await session.startAgent(context.roleId!);
  } catch (err) {
    process.stderr.write(
      `Error: ${String(err instanceof Error ? err.message : err)}\n`,
    );
    process.exit(1);
  }

  if (cmdOpts.query) {
    await runOneShotQuery(session, rootAgentId, cmdOpts.query);
    return;
  }
  await runReadlineInteractive(session, rootAgentId);
}
