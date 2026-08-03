// Pure helper for reading the agent event stream (Server-Sent Events). Kept
// separate from the surfaces so the parsing logic can be unit-tested without
// wiring up a live HTTP stream.

import { WireEvent } from '@tcp/shared';

/**
 * Splits accumulated SSE text on event boundaries (`\n\n`) and parses each
 * `data:` line as a {@link WireEvent} — the unified wire shape the server
 * emits — returning the parsed events plus any trailing partial event still
 * buffered for the next read. Malformed events are skipped rather than throwing.
 */
export function parseWireEvents(buffer: string): {
  events: WireEvent[];
  rest: string;
} {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  const events: WireEvent[] = [];
  for (const part of parts) {
    const dataLine = part.split('\n').find((l) => l.startsWith('data:'));
    if (!dataLine) continue;
    try {
      events.push(JSON.parse(dataLine.slice(5).trim()) as WireEvent);
    } catch {
      // ignore malformed SSE events
    }
  }
  return { events, rest };
}
