// Maps an agent's persisted audit history into the same event shapes the
// live SSE stream produces, so a completed assignment's read-only chat panel
// can render its history through the same PaneEntryLog/createRenderer
// pipeline as a live turn. Audit rows never capture reasoning (only
// on_chat_model_start/end and tool start/end are audited, not the
// token-by-token stream), so historical playback shows the final response
// text per turn but no reasoning trace; `llm_request`/`tool_call`/
// `tool_result`/`decision` rows carry no reconstructable conversational
// content either (no tool name is recorded in the audited payload) and are
// skipped — `eavesdrop --show-history` is the place for that level of detail.

import { extractContentText } from '@lcp/shared';
import { SseEvent } from './sse';

/** Minimal shape of one audit row, as returned by the `.../history` endpoints. */
export interface AuditRow {
  timestamp: string;
  eventType: string;
  payload?: Record<string, unknown>;
}

/** Extracts an audited `llm_response` payload's `output.content` (a chat model's final message text). */
function extractResponseText(payload: Record<string, unknown>): string {
  const output = payload['output'];
  if (!output || typeof output !== 'object') return '';
  return extractContentText((output as Record<string, unknown>)['content']);
}

/**
 * Maps one agent's audit history (oldest first) into {@link SseEvent}s:
 * `state_change` → `agent_status`, `llm_response` → one full `response`
 * block per turn (not token-streamed), `agent_loop_completion` passed
 * through as-is (rendered with its fixed "assignment complete" header by
 * `PaneEntryLog`/`createRenderer`, same as the live path).
 */
export function mapAuditHistoryToEvents(rows: AuditRow[]): SseEvent[] {
  const events: SseEvent[] = [];
  for (const row of rows) {
    const payload = row.payload ?? {};
    switch (row.eventType) {
      case 'state_change':
        events.push({
          kind: 'agent_status',
          timestamp: row.timestamp,
          data: { status: payload.newStatus, reason: payload.reason },
        });
        break;
      case 'llm_response': {
        const text = extractResponseText(payload);
        if (text) {
          events.push({
            kind: 'response',
            timestamp: row.timestamp,
            data: { delta: text },
          });
        }
        break;
      }
      case 'agent_loop_completion':
        events.push({
          kind: 'agent_loop_completion',
          timestamp: row.timestamp,
          data: payload,
        });
        break;
      default:
        break;
    }
  }
  return events;
}
