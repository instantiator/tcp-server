import { AuditWireEvent, StreamDelta } from '@tcp/shared';
import { EventLogBuffer } from './event-log';
import { HeadingInfo } from './heading';
import { plainStyle } from './style';

function audit(
  eventType: string,
  payload: Record<string, unknown>,
  scope: Partial<
    Pick<AuditWireEvent, 'taskId' | 'assignmentId' | 'agentId'>
  > = {},
): AuditWireEvent {
  return {
    timestamp: '2026-07-19T14:03:22.000Z',
    companyId: 'c',
    role: 'r',
    agentId: scope.agentId ?? 'ag',
    assignmentId: scope.assignmentId ?? null,
    taskId: scope.taskId ?? null,
    eventType: eventType as AuditWireEvent['eventType'],
    payload,
  };
}

const TS = '2026-07-19T14:03:22.000Z';
/** The event timestamp as local hh:mm:ss — matches `parseClockTime`, TZ-independent. */
const HH = new Date(TS).toTimeString().slice(0, 8);

function delta(channel: 'reasoning' | 'response', d: string): StreamDelta {
  return { type: 'stream', agentId: 'ag', channel, delta: d, timestamp: TS };
}

const noHeadingInfo = (): HeadingInfo => ({});

describe('EventLogBuffer', () => {
  it('merges consecutive same-channel deltas into one entry', () => {
    const buf = new EventLogBuffer(noHeadingInfo);
    buf.appendDelta(delta('response', 'Hel'));
    buf.appendDelta(delta('response', 'lo'));
    const lines = buf.render(80, plainStyle);
    expect(lines).toEqual([`${HH} | llm_response:response |`, '', '  Hello']);
  });

  it('applies the dedupe rule: after deltas, llm_response renders line-only', () => {
    const buf = new EventLogBuffer(noHeadingInfo);
    buf.appendAudit(audit('llm_request', {}));
    buf.appendDelta(delta('response', 'answer'));
    buf.appendAudit(audit('llm_response', { responseText: 'answer' }));
    const lines = buf.render(80, plainStyle);
    // The response block from the delta, then a line-only llm_response — its
    // text is not re-printed as a block.
    expect(lines).toContain(`${HH} | llm_response:response |`);
    expect(lines).toContain(`${HH} | llm_response | `);
    expect(lines.filter((l) => l.includes('answer'))).toEqual(['  answer']);
    // Regression: the dedupe line must never render as an empty content
    // block — that shows the "(blank)" placeholder meant for a genuinely
    // empty response, which is misleading once the real text already
    // streamed live above it.
    expect(lines.join('\n')).not.toContain('(blank)');
  });

  it('replays history (no deltas) as full response blocks', () => {
    const buf = new EventLogBuffer(noHeadingInfo);
    buf.appendAudit(audit('llm_request', {}));
    buf.appendAudit(audit('llm_response', { responseText: 'answer' }));
    const lines = buf.render(80, plainStyle);
    expect(lines).toContain('  answer');
  });

  it('emits a heading only when the scope tuple changes', () => {
    const headings: HeadingInfo[] = [];
    const buf = new EventLogBuffer((scope) => {
      const info: HeadingInfo = { agentId: scope.agentId ?? undefined };
      headings.push(info);
      return info;
    });
    buf.appendAudit(
      audit('state_change', { newStatus: 'running' }, { agentId: 'a1' }),
    );
    buf.appendAudit(
      audit('state_change', { newStatus: 'idle' }, { agentId: 'a1' }),
    );
    buf.appendAudit(
      audit('state_change', { newStatus: 'running' }, { agentId: 'a2' }),
    );
    // a1 (first), then a2 (change) — not a1's second event.
    expect(headings.map((h) => h.agentId)).toEqual(['a1', 'a2']);
  });

  it('a whitespace-only leading delta does not arm the dedupe collapse — the real llm_response still renders in full', () => {
    const buf = new EventLogBuffer(noHeadingInfo);
    buf.appendAudit(audit('llm_request', {}));
    // A single framing/whitespace-only chunk, then nothing else streams —
    // e.g. a provider that emits one leading token before falling back to a
    // non-streaming completion for the rest of the turn.
    buf.appendDelta(delta('response', ' '));
    buf.appendAudit(
      audit('llm_response', {
        reasoningText: 'thinking it through',
        responseText: 'the real answer',
      }),
    );
    const lines = buf.render(80, plainStyle);
    expect(lines).toContain('  thinking it through');
    expect(lines).toContain('  the real answer');
  });

  it('drops reasoning when hideReasoning is set', () => {
    const buf = new EventLogBuffer(noHeadingInfo, true);
    buf.appendDelta(delta('reasoning', 'secret'));
    buf.appendDelta(delta('response', 'shown'));
    const lines = buf.render(80, plainStyle);
    expect(lines.join('\n')).not.toContain('secret');
    expect(lines.join('\n')).toContain('shown');
  });
});
