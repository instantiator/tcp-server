import { parseSseBuffer, SseEvent } from './sse';

// ponytail: this is the minimal fetch+reader+parseSseBuffer loop shared by
// consumers that just want a callback per event (currently: the company
// events stream backing the TUI's live Tasks list). `ChatSession.streamAgent`
// has its own copy with terminal-event/consultation-following logic that
// doesn't fit this shape — not folded in here to avoid touching that
// already-covered code for a marginal DRY gain. Promote this if a third
// consumer needs the same bare-bones loop.

/**
 * Opens an authenticated SSE GET request and invokes `onEvent` for each
 * parsed event until the stream ends or `signal` aborts. Resolves (does not
 * throw) on an aborted fetch; other failures are silently swallowed too,
 * since every current caller treats the stream as best-effort.
 */
export async function readSseStream(
  url: string,
  token: string,
  signal: AbortSignal,
  onEvent: (event: SseEvent) => void,
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
      const { events, rest } = parseSseBuffer(buffer);
      buffer = rest;
      for (const event of events) onEvent(event);
    }
  } catch {
    // best-effort: an aborted or dropped connection just stops updating.
  }
}
