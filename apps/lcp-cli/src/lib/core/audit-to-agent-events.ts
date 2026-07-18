// Maps an agent's persisted audit history into the same event shapes the
// live SSE stream produces, so an assignment's read-only chat panel can render
// its history through the same PaneEntryLog/createRenderer pipeline as a live
// turn (and pick up seamlessly with live events for a still-running agent).
// The token-by-token reasoning/response *stream* isn't audited (only
// on_chat_model_start/end and tool start/end rows are), but each turn's
// on_chat_model_end (`llm_response`) row carries that turn's final response
// text AND, for providers that expose it (e.g. LM Studio), its full
// `reasoning_content` — so history replays a turn's reasoning, response, and
// the tools it ran, just not the incremental typing. `llm_request`/
// `tool_call`/`decision` rows carry no reconstructable display content (the
// audited `tool_call` payload records the input but not the tool name — only
// the paired `tool_result` does) and are skipped.

import { extractContentText } from '@lcp/shared';
import { SseEvent } from './sse';

/** Minimal shape of one audit row, as returned by the `.../history` endpoints. */
export interface AuditRow {
  timestamp: string;
  eventType: string;
  payload?: Record<string, unknown>;
}

/** The `output.kwargs` of an audited on_chat_model_end (`llm_response`) row, if present. */
function responseKwargs(
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const output = payload['output'];
  if (!output || typeof output !== 'object') return undefined;
  const kwargs = (output as Record<string, unknown>)['kwargs'];
  return kwargs && typeof kwargs === 'object'
    ? (kwargs as Record<string, unknown>)
    : undefined;
}

/** Extracts an audited `llm_response` payload's `output.content` (a chat model's final message text). */
function extractResponseText(payload: Record<string, unknown>): string {
  const output = payload['output'];
  if (!output || typeof output !== 'object') return '';
  return extractContentText((output as Record<string, unknown>)['content']);
}

/**
 * Extracts an audited `llm_response` payload's final `reasoning_content` —
 * `output.kwargs.additional_kwargs.reasoning_content` — the turn's whole
 * reasoning trace (present only for providers that expose it; '' otherwise).
 */
function extractReasoningText(payload: Record<string, unknown>): string {
  const additional = responseKwargs(payload)?.['additional_kwargs'];
  if (!additional || typeof additional !== 'object') return '';
  const reasoning = (additional as Record<string, unknown>)[
    'reasoning_content'
  ];
  return typeof reasoning === 'string' ? reasoning : '';
}

/**
 * Extracts the tool name from an audited `tool_result` payload — a LangGraph
 * `ToolMessage`, whose `output.kwargs.name` is the tool that ran (the paired
 * `tool_call`/`on_tool_start` row records only the input, not the name).
 */
function extractToolName(payload: Record<string, unknown>): string {
  const name = responseKwargs(payload)?.['name'];
  return typeof name === 'string' ? name : '';
}

/**
 * Maps one agent's audit history (oldest first) into {@link SseEvent}s:
 * `state_change` → `agent_status`, `llm_response` → that turn's `reasoning`
 * trace (when the provider captured one) followed by its full `response`
 * block — both as one block each, not token-streamed — `tool_result` → an
 * `llm` `tool_complete` activity line (mirroring the live stream's tool
 * events, so a tool-heavy agent's history isn't near-empty),
 * `agent_loop_completion` passed through as-is (rendered with its fixed
 * "assignment complete" header by `PaneEntryLog`/`createRenderer`, same as the
 * live path). Reasoning precedes response within a turn, matching the live
 * "reason, then act" order; a `reasoning` event is subject to the same
 * `--hide-reasoning` gating as the live stream.
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
        const reasoning = extractReasoningText(payload);
        if (reasoning) {
          events.push({
            kind: 'reasoning',
            timestamp: row.timestamp,
            data: { delta: reasoning },
          });
        }
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
      case 'tool_result': {
        const tool = extractToolName(payload);
        if (tool) {
          events.push({
            kind: 'llm',
            timestamp: row.timestamp,
            data: { activity: 'tool_complete', tool },
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
