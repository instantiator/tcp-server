// Converts one audit event into zero or more LogEntries. A registry of small
// renderers (first `canRender` wins) shared by the CLI and the web transcript.

import type { AuditWireEvent } from '../events/wire-events';
import { ASSIGNMENT_COMPLETE_LABEL, parseClockTime } from './format';
import type { ConsultationStep, LogEntry, ToolSummary } from './entries';
import {
  compactionSummary,
  eventLabel,
  reasoningText,
  responseText,
  stateChangeText,
} from './line-format';

/** Turn-level flags threaded through rendering so streamed content isn't re-rendered from its audit row. */
export interface TurnState {
  /** True once a stream delta has been seen this turn (see {@link EventLogBuffer}'s dedupe rule). */
  deltasSeen: boolean;
}

/** Converts one audit event to zero or more {@link LogEntry}s. */
export interface AuditEventRenderer {
  canRender(e: AuditWireEvent): boolean;
  toEntries(e: AuditWireEvent, state: TurnState): LogEntry[];
}

/** hh:mm:ss from an event's timestamp, or from now if absent/invalid. */
function clock(e: AuditWireEvent): string {
  return parseClockTime(e.timestamp) ?? new Date().toTimeString().slice(0, 8);
}

/** A payload field as a string, or `''`. */
const text = (payload: Record<string, unknown>, key: string): string =>
  typeof payload[key] === 'string' ? payload[key] : '';

/** A consultation entry; the label reads on its own in a terminal, e.g. `consultation:Analyst answered`. */
function consultationEntry(
  time: string,
  step: ConsultationStep,
  body: string,
): LogEntry {
  const label = {
    asked: `asked ${step.roleName}`,
    answered: `${step.roleName} answered`,
    failed: `${step.roleName} couldn't answer`,
  }[step.kind];
  return {
    style: 'consultation',
    time,
    label: `consultation:${label}`,
    text: body,
    consultation: step,
  };
}

/**
 * All `state_change` rows — one line-only `newStatus (reason)`. A pause to
 * consult that carries its question becomes the consultation's `asked` entry.
 */
class StateChangeAuditEventRenderer implements AuditEventRenderer {
  canRender(e: AuditWireEvent): boolean {
    return e.eventType === 'state_change';
  }
  toEntries(e: AuditWireEvent): LogEntry[] {
    const question = text(e.payload, 'question');
    if (e.payload['reason'] === 'consultation' && question) {
      return [
        consultationEntry(
          clock(e),
          {
            agentId: text(e.payload, 'consultedAgentId'),
            roleName: text(e.payload, 'consultedRoleName'),
            kind: 'asked',
          },
          question,
        ),
      ];
    }
    return [
      {
        style: 'state',
        time: clock(e),
        label: eventLabel(e),
        text: stateChangeText(e.payload),
      },
    ];
  }
}

/**
 * `input` (user text), `agent_loop_completion` (summary), and `llm_response`
 * (a reasoning block then a response block, from the enriched/legacy text).
 * When deltas already streamed the turn, `llm_response` collapses to a single
 * line so its content isn't printed twice.
 */
class TextContentAuditEventRenderer implements AuditEventRenderer {
  canRender(e: AuditWireEvent): boolean {
    return (
      e.eventType === 'input' ||
      e.eventType === 'agent_loop_completion' ||
      e.eventType === 'llm_response'
    );
  }
  toEntries(e: AuditWireEvent, state: TurnState): LogEntry[] {
    const time = clock(e);
    if (e.eventType === 'input') {
      return [inputEntry(e, time)];
    }
    if (e.eventType === 'agent_loop_completion') {
      const summary =
        typeof e.payload['summary'] === 'string' ? e.payload['summary'] : '';
      // Line-only (a wrapped summary line), keeping the fixed completion label.
      return [
        { style: 'llm', time, label: ASSIGNMENT_COMPLETE_LABEL, text: summary },
      ];
    }
    // llm_response — its content already streamed live as deltas, so this
    // collapses to a line-only marker instead of a content block: `response`
    // is a block style, and an empty block renders the "(blank)" placeholder
    // meant for a genuinely empty final answer, which is misleading here —
    // the real text is already on screen a few lines up.
    if (state.deltasSeen) {
      return [{ style: 'llm', time, label: 'llm_response', text: '' }];
    }
    const entries: LogEntry[] = [];
    const reasoning = reasoningText(e.payload);
    if (reasoning) {
      entries.push({
        style: 'reasoning',
        time,
        label: 'llm_response:reasoning',
        text: reasoning,
      });
    }
    const response = responseText(e.payload);
    if (response) {
      entries.push({
        style: 'response',
        time,
        label: 'llm_response:response',
        text: response,
      });
    }
    return entries;
  }
}

/**
 * An `input` row: a person's message, a consultation's question as the
 * consulted agent sees it (labelled with who asked), or a consultation's
 * answer as the asking agent sees it.
 */
function inputEntry(e: AuditWireEvent, time: string): LogEntry {
  const body = text(e.payload, 'text');
  const consultedAgentId = text(e.payload, 'consultedAgentId');
  if (e.payload['source'] === 'consultation' && consultedAgentId) {
    return consultationEntry(
      time,
      {
        agentId: consultedAgentId,
        roleName: text(e.payload, 'consultedRoleName'),
        kind: e.payload['failed'] === true ? 'failed' : 'answered',
      },
      body,
    );
  }
  const from = text(e.payload, 'fromRoleName');
  return {
    style: 'user',
    time,
    label: from ? `input:from ${from}` : 'input',
    text: body,
  };
}

/** `tool_call`/`tool_result` — a pretty-printed `{tool, input|output}` JSON block. Never renders `llm_request` bodies. */
class JsonTextContentAuditEventRenderer implements AuditEventRenderer {
  canRender(e: AuditWireEvent): boolean {
    return e.eventType === 'tool_call' || e.eventType === 'tool_result';
  }
  toEntries(e: AuditWireEvent): LogEntry[] {
    const body =
      e.eventType === 'tool_call'
        ? { tool: e.payload['tool'], input: e.payload['input'] }
        : { tool: e.payload['tool'], output: e.payload['output'] };
    return [
      {
        style: 'json',
        time: clock(e),
        label: eventLabel(e),
        text: JSON.stringify(body, null, 2),
        json: true,
        tool: summariseTool(e),
      },
    ];
  }
}

/** Whether a value is a non-null object, so its fields can be read. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** A content value as text: a string, or the joined text of `{ type: 'text', text }` parts. */
function contentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((part) =>
    isRecord(part) && typeof part['text'] === 'string' ? [part['text']] : [],
  );
  return parts.length > 0 ? parts.join('') : undefined;
}

/**
 * The key facts of a tool event. A result's output is usually a serialised
 * LangChain `ToolMessage` (`{ kwargs: { status, content } }`), sometimes a
 * plain string. Any other shape yields the name alone: the full JSON is still
 * in the entry's `text`.
 */
function summariseTool(e: AuditWireEvent): ToolSummary {
  const tool = e.payload['tool'];
  const summary: ToolSummary = {
    name: typeof tool === 'string' ? tool : 'unknown',
  };
  if (e.eventType !== 'tool_result') return summary;
  const output = e.payload['output'];
  const fields =
    isRecord(output) && isRecord(output['kwargs'])
      ? output['kwargs']
      : undefined;
  const status = fields?.['status'];
  if (typeof status === 'string') summary.status = status;
  const content = contentText(
    fields === undefined ? output : fields['content'],
  );
  if (content !== undefined) summary.content = content;
  return summary;
}

/** `llm_request` (bare line), `decision` (its summary), `compaction` (its metrics) — all line-only. */
class LineOnlyAuditEventRenderer implements AuditEventRenderer {
  canRender(e: AuditWireEvent): boolean {
    return (
      e.eventType === 'llm_request' ||
      e.eventType === 'decision' ||
      e.eventType === 'compaction'
    );
  }
  toEntries(e: AuditWireEvent): LogEntry[] {
    let text = '';
    if (e.eventType === 'decision') {
      text =
        typeof e.payload['summary'] === 'string' ? e.payload['summary'] : '';
    } else if (e.eventType === 'compaction') {
      text = compactionSummary(e.payload);
    }
    return [{ style: 'llm', time: clock(e), label: eventLabel(e), text }];
  }
}

/** Registry, first `canRender` wins. */
const RENDERERS: AuditEventRenderer[] = [
  new StateChangeAuditEventRenderer(),
  new TextContentAuditEventRenderer(),
  new JsonTextContentAuditEventRenderer(),
  new LineOnlyAuditEventRenderer(),
];

/**
 * Renders one audit event via the first matching renderer, or a bare
 * `time | eventType` line as a fallback for any unknown type.
 */
export function renderAuditEvent(
  e: AuditWireEvent,
  state: TurnState,
): LogEntry[] {
  const renderer = RENDERERS.find((r) => r.canRender(e));
  if (renderer) return renderer.toEntries(e, state);
  return [{ style: 'llm', time: clock(e), label: e.eventType, text: '' }];
}
