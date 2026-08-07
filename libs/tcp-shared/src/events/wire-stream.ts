// Reading the company, task and agent event streams (Server-Sent Events). The
// one implementation both tcp-cli and the web client use, so they cannot drift
// on what an event means (ADR-025). Parsing is kept separate from the request
// so it can be unit-tested without a live HTTP stream.

import type { WireEvent } from './wire-events';

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

// ponytail: the minimal fetch+reader+parseWireEvents loop shared by consumers
// that just want a callback per event (the company/task events streams, and
// eavesdrop's per-agent/task follows). `ChatSession.streamAgent` has its own
// copy with terminal-event/consultation-following logic that doesn't fit this
// shape — not folded in here to avoid touching that already-covered code for a
// marginal DRY gain.

/**
 * How a {@link readWireStream} call ended, so a reconnecting caller can decide
 * whether to retry. `status: 0` means the request never landed (network
 * failure, or a body-less response) — the same convention `ApiError` uses in
 * `src/api/errors.ts`.
 */
export type StreamEnd =
  | { reason: 'done' }
  | { reason: 'aborted' }
  | { reason: 'failed'; status: number; cause?: unknown };

/**
 * Opens an authenticated SSE GET request and invokes `onEvent` for each parsed
 * {@link WireEvent} until the stream ends or `signal` aborts, then reports how
 * it ended via {@link StreamEnd}. `onOpen` fires once the response is known to
 * be ok, before the first read — a reconnecting caller uses it to reset its
 * backoff. Never throws: every failure mode, including an aborted or dropped
 * connection, resolves to a {@link StreamEnd} instead.
 */
export async function readWireStream(
  url: string,
  token: string,
  signal: AbortSignal,
  onEvent: (event: WireEvent) => void,
  onOpen?: () => void,
): Promise<StreamEnd> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!res.ok) return { reason: 'failed', status: res.status };
    if (!res.body) return { reason: 'failed', status: 0 };
    onOpen?.();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseWireEvents(buffer);
      buffer = rest;
      for (const event of events) onEvent(event);
    }
    return { reason: 'done' };
  } catch (cause) {
    if (signal.aborted) return { reason: 'aborted' };
    return { reason: 'failed', status: 0, cause };
  }
}
