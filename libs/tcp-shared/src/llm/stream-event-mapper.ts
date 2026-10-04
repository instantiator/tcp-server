import { AuditEventType } from '../models/AuditEvent.model';
import type { StreamDelta } from '../events/wire-events';
import { extractContentText } from './content-text';
import type { LlmIdentity } from './llm-usage';
import { usageFromMessage } from './llm-usage';

/**
 * The subset of a LangGraph `streamEvents(..., { version: 'v2' })` event that
 * the mapper reads. Typed structurally so callers can pass raw stream events
 * without importing LangGraph's full event union here.
 */
export interface StreamEventLike {
  event: string;
  name?: string;
  data?: {
    chunk?: {
      content?: unknown;
      additional_kwargs?: Record<string, unknown>;
    };
    /** Present on `on_chat_model_end`/`on_tool_end` — the node's return value. */
    output?: unknown;
    /** Present on `on_tool_start` — the tool call's input arguments. */
    input?: Record<string, unknown>;
  };
  /** Present on tool events — correlates `on_tool_start`/`on_tool_end` pairs. */
  run_id?: string;
}

/** Reads a string field, returning `''` when it is absent or not a string. */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// Re-exported from its own import-free module so the browser-safe surface can
// export it too — see `content-text.ts` for why it had to move out of here.
export { extractContentText } from './content-text';

/**
 * Translates one LangGraph `on_chat_model_stream` event into zero or more
 * live {@link StreamDelta}s (response and/or reasoning). Pure but for the
 * timestamp, taken once per call. Lifecycle events (start/end/tool) are no
 * longer mapped here — they are captured as audit rows and streamed live by
 * the server's persist-then-publish path (`docs/prompts/010.5.1` A.5).
 *
 * A stream chunk with neither response nor reasoning content yields nothing.
 * `reasoning_content` is only present for providers that expose it (e.g. LM
 * Studio); its absence degrades gracefully to response-only.
 */
/** LangGraph v2 lifecycle event names that map to an {@link AuditEventType}. */
const EVENT_AUDIT_TYPE: Record<string, AuditEventType> = {
  on_chat_model_start: AuditEventType.LlmRequest,
  on_chat_model_end: AuditEventType.LlmResponse,
  on_tool_start: AuditEventType.ToolCall,
  on_tool_end: AuditEventType.ToolResult,
};

/** An audit row derived from one LangGraph lifecycle stream event. */
export interface EnrichedAuditEvent {
  eventType: AuditEventType;
  payload: Record<string, unknown>;
}

/** Reads a nested field of an unknown object without a type escape. */
function field(obj: unknown, key: string): unknown {
  return obj && typeof obj === 'object'
    ? (obj as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Derives the audit row (type + enriched payload) for one LangGraph lifecycle
 * stream event, or `null` for non-lifecycle events (deltas). Shared by both
 * agent-loop and chat turns so the persisted payload — and therefore the
 * live-streamed and replayed rendering — is identical (`docs/prompts/010.5.1`
 * A.4): `tool_call`/`tool_result` carry the tool name; `llm_response` carries
 * normalized `responseText`/`reasoningText` alongside the raw `output`.
 */
export function enrichedAuditForEvent(
  event: StreamEventLike,
  llm?: LlmIdentity,
): EnrichedAuditEvent | null {
  const eventType = EVENT_AUDIT_TYPE[event.event];
  if (!eventType) return null;

  switch (event.event) {
    case 'on_tool_start':
      return {
        eventType,
        payload: { tool: event.name, input: event.data?.input ?? {} },
      };
    case 'on_tool_end':
      return {
        eventType,
        payload: { tool: event.name, output: event.data?.output },
      };
    case 'on_chat_model_end': {
      const output = event.data?.output;
      // Token usage is only attributable with the caller's provider/model
      // identity in hand. A provider that reports none is named instead, so
      // tcp-server can warn that its spend isn't being tracked.
      const usage = llm ? usageFromMessage(output, llm) : undefined;
      const untracked =
        llm && !usage ? { untrackedProvider: llm.provider } : {};
      return {
        eventType,
        payload: {
          output,
          responseText: extractContentText(field(output, 'content')),
          reasoningText: asText(
            field(field(output, 'additional_kwargs'), 'reasoning_content'),
          ),
          ...(usage ? { usage } : {}),
          ...untracked,
        },
      };
    }
    default:
      return { eventType, payload: event.data ?? {} };
  }
}

export function mapStreamDeltas(
  event: StreamEventLike,
  agentId: string,
): StreamDelta[] {
  if (event.event !== 'on_chat_model_stream') return [];

  const timestamp = new Date().toISOString();
  const chunk = event.data?.chunk;
  const deltas: StreamDelta[] = [];
  // ponytail: only string content handled; array content-block deltas
  // (some providers) are skipped — LM Studio/OpenAI send strings.
  const response = asText(chunk?.content);
  if (response) {
    deltas.push({
      type: 'stream',
      agentId,
      channel: 'response',
      delta: response,
      timestamp,
    });
  }
  const reasoning = asText(chunk?.additional_kwargs?.reasoning_content);
  if (reasoning) {
    deltas.push({
      type: 'stream',
      agentId,
      channel: 'reasoning',
      delta: reasoning,
      timestamp,
    });
  }
  return deltas;
}
