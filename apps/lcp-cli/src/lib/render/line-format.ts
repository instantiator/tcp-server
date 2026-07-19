// Label building and payload extraction for audit events — the one legacy-
// compat module. The extractors read the current enriched payloads
// (`responseText`/`reasoningText`/`tool`) and fall back to the raw LangGraph
// message shapes older rows carry, so pre-migration history still renders
// best-effort (`docs/prompts/010.5.1` B.7).

import { AuditWireEvent, extractContentText } from '@lcp/shared';

/** Reads a string field, defaulting to ''. */
function str(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === 'string' ? v : '';
}

/**
 * Infers a `state_change`'s entity for legacy rows written before the
 * mandatory `payload.entity` discriminator: an explicit `taskId` in the
 * payload → task; an `assignmentId` with no producing agent → assignment;
 * otherwise agent.
 */
export function inferEntity(e: AuditWireEvent): string {
  const explicit = str(e.payload, 'entity');
  if (explicit) return explicit;
  if (e.payload['taskId']) return 'task';
  if (e.payload['assignmentId'] && !e.agentId) return 'assignment';
  return 'agent';
}

/** Tool name of a `tool_call`/`tool_result` — the enriched `tool`, else the legacy `ToolMessage` name. */
export function toolName(payload: Record<string, unknown>): string {
  const enriched = str(payload, 'tool');
  if (enriched) return enriched;
  const output = payload['output'];
  const kwargs =
    output && typeof output === 'object'
      ? (output as Record<string, unknown>)['kwargs']
      : undefined;
  return kwargs && typeof kwargs === 'object'
    ? str(kwargs as Record<string, unknown>, 'name')
    : '';
}

/** An `llm_response`'s final response text — the enriched `responseText`, else legacy `output.content`. */
export function responseText(payload: Record<string, unknown>): string {
  const enriched = payload['responseText'];
  if (typeof enriched === 'string') return enriched;
  const output = payload['output'];
  if (!output || typeof output !== 'object') return '';
  return extractContentText((output as Record<string, unknown>)['content']);
}

/** An `llm_response`'s reasoning trace — the enriched `reasoningText`, else legacy `additional_kwargs.reasoning_content`. */
export function reasoningText(payload: Record<string, unknown>): string {
  const enriched = payload['reasoningText'];
  if (typeof enriched === 'string') return enriched;
  const output = payload['output'];
  const kwargs =
    output && typeof output === 'object'
      ? (output as Record<string, unknown>)['kwargs']
      : undefined;
  const additional =
    kwargs && typeof kwargs === 'object'
      ? (kwargs as Record<string, unknown>)['additional_kwargs']
      : undefined;
  return additional && typeof additional === 'object'
    ? str(additional as Record<string, unknown>, 'reasoning_content')
    : '';
}

/**
 * Builds the `<AuditEventType>[:kind]` label shown after the timestamp:
 * `state_change:<entity>`, `compaction:<phase>`, `tool_call:<tool>` /
 * `tool_result:<tool>` (bare when a legacy row has no tool name), or the bare
 * event type for `llm_request`/`input`/`decision`/`agent_loop_completion`.
 * `llm_response` splits into `:reasoning`/`:response` sub-labels in its
 * renderer, not here.
 */
export function eventLabel(e: AuditWireEvent): string {
  switch (e.eventType) {
    case 'state_change':
      return `state_change:${inferEntity(e)}`;
    case 'compaction':
      return `compaction:${str(e.payload, 'phase')}`;
    case 'tool_call':
    case 'tool_result': {
      const tool = toolName(e.payload);
      return tool ? `${e.eventType}:${tool}` : e.eventType;
    }
    default:
      return e.eventType;
  }
}

/** Renders a numeric field, falling back to '?' when it is not a number. */
function num(value: unknown): number | string {
  return typeof value === 'number' ? value : '?';
}

/** One-line summary of a `compaction` row's metrics — the single surviving compaction formatter. */
export function compactionSummary(payload: Record<string, unknown>): string {
  if (payload['phase'] === 'started') {
    const strats = Array.isArray(payload['strategies'])
      ? (payload['strategies'] as string[]).join(', ')
      : '';
    return `strategies=[${strats}], ${num(payload['tokensBefore'])}/${num(payload['windowSize'])} tokens (${num(payload['pct'])}%)`;
  }
  return `${num(payload['tokensAfter'])}/${num(payload['windowSize'])} tokens (${num(payload['pct'])}%)`;
}

/** The trailing line-only text of a `state_change`: `newStatus (reason)`, reason optional. */
export function stateChangeText(payload: Record<string, unknown>): string {
  const status = str(payload, 'newStatus');
  const reason = str(payload, 'reason');
  return reason ? `${status} (${reason})` : status;
}
