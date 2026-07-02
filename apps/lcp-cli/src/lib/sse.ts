// Pure helpers for reading the agent event stream (Server-Sent Events).
// Kept separate from the chat command so the parsing/formatting logic can be
// unit-tested without wiring up a live HTTP stream.

/** A single parsed SSE event: its kind plus any structured data payload. */
export interface SseEvent {
  kind: string;
  data?: Record<string, unknown>;
}

/**
 * Splits accumulated SSE text on event boundaries (`\n\n`), parses the `data:`
 * line of each complete event as JSON, and returns the parsed events together
 * with any trailing partial event still buffered for the next read.
 * Malformed events are skipped rather than throwing.
 */
export function parseSseBuffer(buffer: string): {
  events: SseEvent[];
  rest: string;
} {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  const events: SseEvent[] = [];
  for (const part of parts) {
    const dataLine = part.split('\n').find((l) => l.startsWith('data:'));
    if (!dataLine) continue;
    try {
      events.push(JSON.parse(dataLine.slice(5).trim()) as SseEvent);
    } catch {
      // ignore malformed SSE events
    }
  }
  return { events, rest };
}

/** Renders a numeric field, falling back to '?' when it is not a number. */
function num(value: unknown): number | string {
  return typeof value === 'number' ? value : '?';
}

/**
 * Formats a context-compaction lifecycle event as a one-line status string,
 * or returns null for events that should not be displayed. Handles both the
 * start and completion events emitted while the server trims context to fit
 * the model's window.
 */
export function formatCompactionEvent(event: SseEvent): string | null {
  const d = event.data ?? {};
  if (event.kind === 'compaction_started') {
    const strats = Array.isArray(d.strategies)
      ? (d.strategies as string[]).join(', ')
      : '';
    return `[Context compacting: strategies=[${strats}], ${num(d.tokensBefore)}/${num(d.windowSize)} tokens (${num(d.pct)}%)]`;
  }
  if (event.kind === 'compaction_complete') {
    return `[Context compacted: ${num(d.tokensAfter)}/${num(d.windowSize)} tokens (${num(d.pctAfter)}%)]`;
  }
  return null;
}
