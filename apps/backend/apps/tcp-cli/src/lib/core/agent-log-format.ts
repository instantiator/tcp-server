// Shared, non-terminal-kit-dependent formatting for one agent's event/audit
// log. Used by both eavesdrop.action.ts (plain stdout) and tui-format.ts
// (terminal-kit markup) so the two surfaces present the same short-id,
// per-agent-heading, JSON-delta, and blank-response conventions without
// duplicating the logic.

/** First 8 hex characters of a UUID — the short-id convention for log-line prefixes. */
export function shortId(uuid: string): string {
  return uuid.slice(0, 8);
}

/** Identifying context for one agent, printed as a heading whenever the active agent changes. */
export interface AgentHeadingContext {
  assignmentId: string;
  assignmentRole: string;
  agentId: string;
  roleId: string;
  roleSlug: string;
}

/** Renders the 5-line heading block identifying an agent and its assignment. */
export function agentHeading(ctx: AgentHeadingContext): string[] {
  return [
    `Assignment id: ${ctx.assignmentId}`,
    `Assignment role: ${ctx.assignmentRole}`,
    `Agent id: ${ctx.agentId}`,
    `Agent role id: ${ctx.roleId}`,
    `Agent role slug: ${ctx.roleSlug}`,
  ];
}

/**
 * Tracks the last agent id a heading was printed for, so an output stream
 * that interleaves more than one agent (e.g. `eavesdrop --tail --task-id`, or
 * a TUI pane spanning a consultation) only reprints {@link agentHeading} when
 * the active agent actually changes, not on every line. One instance per
 * output stream/pane.
 */
export class LogHeadingTracker {
  private lastAgentId: string | null = null;

  /** True the first time `agentId` is seen, or whenever it differs from the last-printed one. */
  shouldPrintHeading(agentId: string): boolean {
    if (agentId === this.lastAgentId) return false;
    this.lastAgentId = agentId;
    return true;
  }
}

/** Reads `payload.input.messages` as an array, or `[]` if the shape doesn't match. */
function requestMessages(payload: unknown): unknown[] {
  const input = (payload as Record<string, unknown> | undefined)?.['input'];
  const messages = (input as Record<string, unknown> | undefined)?.['messages'];
  return Array.isArray(messages) ? messages : [];
}

/**
 * Stateful pretty-printer for `llm_request`/`llm_response` audit/event
 * payloads, showing only what's new since the last call for a given
 * `(kind, agentId)` pair — a request re-sends the full running message
 * history every turn, so only the newly appended messages are worth
 * reprinting; a response has nothing to diff against and prints in full every
 * time. Diff state is kept independently per kind. One instance per output
 * stream/pane, paired with {@link LogHeadingTracker}.
 */
export class JsonDeltaFormatter {
  private readonly seenMessageCounts = new Map<string, number>();

  /** Pretty-prints `payload` (2-space indented), diffed against the last call for this `(kind, agentId)`. */
  format(
    kind: 'llm_request' | 'llm_response',
    agentId: string,
    payload: unknown,
  ): string {
    if (kind === 'llm_response') {
      return JSON.stringify(payload, null, 2);
    }
    // Only 'llm_request' reaches here, so the map only ever needs to key on
    // agentId — no need to also fold kind into the key.
    const messages = requestMessages(payload);
    const seen = this.seenMessageCounts.get(agentId) ?? 0;
    this.seenMessageCounts.set(agentId, messages.length);
    return JSON.stringify(messages.slice(seen), null, 2);
  }
}
