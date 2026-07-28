import { renderTemplate, requiredToolForMode, TcpAgent } from '@tcp/shared';
import type { Logger } from '@nestjs/common';
import { agentPrompts } from '../agent-prompts';
import {
  AgentLoopTracker,
  baseToolName,
  detectDescribedToolCall,
} from './loop-tracker';

/**
 * The mode completion tools (`create_plan`/`complete_assignment`/
 * `assure_assignment`). If one of these is the required tool yet is absent
 * from an agent's loaded toolset, that is a wiring bug — the mode's own
 * completion server was not offered — not a benign optional skip.
 */
const COMPLETION_TOOLS = new Set(
  (['plan', 'implement', 'qa', 'chat'] as const).flatMap(requiredToolForMode),
);

/**
 * Resolves the tool calls this agent must make before its run may end.
 * Null on the agent means the default (`complete_assignment`); an empty array
 * opts out. Required tools missing from the loaded toolset are dropped
 * with a warning — a role without the relevant MCP server must not fail
 * every run inevitably.
 */
export function resolveRequiredTools(
  agent: TcpAgent,
  tools: { name: string }[],
  logger: Logger,
): string[] {
  const required = agent.requiredToolCalls ?? ['complete_assignment'];
  const available = new Set(tools.map((t) => baseToolName(t.name)));
  return required.filter((toolName) => {
    if (available.has(toolName)) return true;
    // A missing completion tool means the mode's own completion server was
    // not offered — a wiring bug that will let the run end without ever
    // completing its assignment. Louder than a benign optional-tool skip.
    const level = COMPLETION_TOOLS.has(toolName) ? 'error' : 'warn';
    logger[level](
      `Agent ${agent.id} requires tool '${toolName}' but it is not in the loaded toolset — skipping enforcement for it`,
    );
    return false;
  });
}

/**
 * Wording for the reminder sent when a run ended without its required tool
 * calls. Distinguishes "never called" from "called but the call did not
 * succeed" (the tool fired yet the status never flipped, e.g.
 * complete_assignment errored), and quotes back a tool call the model merely
 * described in prose rather than invoking.
 *
 * @param callableName - Maps a base tool name to the server-prefixed name the
 *   LLM actually sees, so reminders name tools exactly as it can call them.
 */
export function buildRequiredToolReminder(
  requiredTools: string[],
  tracker: AgentLoopTracker,
  callableName: (base: string) => string,
): string {
  const missing = requiredTools.filter((t) => !tracker.firedTools.has(t));
  if (missing.length === 0) {
    return renderTemplate(agentPrompts.required_tools_call_failed, {
      tools: requiredTools.map(callableName).join(', '),
    });
  }

  const tools = missing.map(callableName).join(', ');
  const describedCall = detectDescribedToolCall(tracker.lastResponseText);
  return describedCall
    ? renderTemplate(agentPrompts.required_tools_reminder_with_described_call, {
        tools,
        describedCall,
      })
    : renderTemplate(agentPrompts.required_tools_reminder, { tools });
}
