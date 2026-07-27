import { WireEvent } from '@tcp/shared';
import { parseWireEvents } from './sse';

// ponytail: the minimal fetch+reader+parseWireEvents loop shared by consumers
// that just want a callback per event (the company/task events streams, and
// eavesdrop's per-agent/task follows). `ChatSession.streamAgent` has its own
// copy with terminal-event/consultation-following logic that doesn't fit this
// shape — not folded in here to avoid touching that already-covered code for a
// marginal DRY gain.

/**
 * Opens an authenticated SSE GET request and invokes `onEvent` for each parsed
 * {@link WireEvent} until the stream ends or `signal` aborts. Resolves (does
 * not throw) on an aborted fetch; other failures are silently swallowed too,
 * since every current caller treats the stream as best-effort.
 */
export async function readWireStream(
  url: string,
  token: string,
  signal: AbortSignal,
  onEvent: (event: WireEvent) => void,
): Promise<void> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!res.ok || !res.body) return;
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
  } catch {
    // best-effort: an aborted or dropped connection just stops updating.
  }
}
