import { AgentEvent } from '../events/agent-events';

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

/** Extracts a content block's `.text` field, or `''` if it isn't shaped that way. */
function blockText(block: unknown): string {
  if (!block || typeof block !== 'object') return '';
  const text = (block as Record<string, unknown>)['text'];
  return typeof text === 'string' ? text : '';
}

/**
 * Extracts plain text from a chat message's `content` field: a plain string,
 * or an array of content blocks (each with a `.text` field), joined. Shared
 * by lcp-agent (reading a turn's final output text) and lcp-cli (mapping an
 * agent's audit history back into displayable text) — both need to read a
 * chat model message's content from the same shape.
 */
export function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(blockText).join('');
  return '';
}

/**
 * Translates one LangGraph stream event into zero or more {@link AgentEvent}s
 * for the observability stream. Pure: the only impurity is the timestamp,
 * taken once per call.
 *
 * - `on_chat_model_start` / `on_chat_model_end` → `llm` request lifecycle
 * - `on_tool_start` / `on_tool_end` → `llm` tool lifecycle (with tool name)
 * - `on_chat_model_stream` → `response` and/or `reasoning` deltas
 *
 * A stream chunk with neither response content nor reasoning content yields
 * no events. `reasoning_content` is only present for providers that expose it
 * (e.g. LM Studio); its absence degrades gracefully to response-only.
 */
export function mapStreamEvent(event: StreamEventLike): AgentEvent[] {
  const timestamp = new Date().toISOString();

  switch (event.event) {
    case 'on_chat_model_start':
      return [
        { timestamp, kind: 'llm', data: { activity: 'request_started' } },
      ];
    case 'on_chat_model_end':
      return [
        { timestamp, kind: 'llm', data: { activity: 'request_complete' } },
      ];
    case 'on_tool_start':
      return [
        {
          timestamp,
          kind: 'llm',
          data: { activity: 'tool_started', tool: event.name },
        },
      ];
    case 'on_tool_end':
      return [
        {
          timestamp,
          kind: 'llm',
          data: { activity: 'tool_complete', tool: event.name },
        },
      ];
    case 'on_chat_model_stream': {
      const chunk = event.data?.chunk;
      const events: AgentEvent[] = [];
      // ponytail: only string content handled; array content-block deltas
      // (some providers) are skipped — LM Studio/OpenAI send strings.
      const response = asText(chunk?.content);
      if (response) {
        events.push({ timestamp, kind: 'response', data: { delta: response } });
      }
      const reasoning = asText(chunk?.additional_kwargs?.reasoning_content);
      if (reasoning) {
        events.push({
          timestamp,
          kind: 'reasoning',
          data: { delta: reasoning },
        });
      }
      return events;
    }
    default:
      return [];
  }
}
