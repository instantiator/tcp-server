import { AuditWireEvent } from '@tcp/shared';
import { renderAuditEvent, TurnState } from './audit-renderers';

function ev(
  eventType: string,
  payload: Record<string, unknown>,
): AuditWireEvent {
  return {
    timestamp: '2026-07-19T14:03:22.000Z',
    companyId: 'c',
    role: 'r',
    agentId: 'ag',
    assignmentId: null,
    taskId: null,
    eventType: eventType as AuditWireEvent['eventType'],
    payload,
  };
}

const fresh = (): TurnState => ({ deltasSeen: false });

describe('renderAuditEvent', () => {
  it('renders a state_change as a single line-only entry', () => {
    const [entry] = renderAuditEvent(
      ev('state_change', { entity: 'agent', newStatus: 'running' }),
      fresh(),
    );
    expect(entry).toMatchObject({
      style: 'state',
      label: 'state_change:agent',
      text: 'running',
    });
  });

  it('renders a tool_call as a pretty-printed JSON block with the tool name', () => {
    const [entry] = renderAuditEvent(
      ev('tool_call', { tool: 'web_search', input: { q: 'x' } }),
      fresh(),
    );
    expect(entry.style).toBe('json');
    expect(entry.json).toBe(true);
    expect(entry.label).toBe('tool_call:web_search');
    expect(JSON.parse(entry.text)).toEqual({
      tool: 'web_search',
      input: { q: 'x' },
    });
  });

  it('replays an llm_response as reasoning then response blocks when no deltas streamed', () => {
    const entries = renderAuditEvent(
      ev('llm_response', { reasoningText: 'because', responseText: 'answer' }),
      fresh(),
    );
    expect(entries.map((e) => e.label)).toEqual([
      'llm_response:reasoning',
      'llm_response:response',
    ]);
    expect(entries.map((e) => e.text)).toEqual(['because', 'answer']);
  });

  it('collapses llm_response to a single line when deltas already streamed', () => {
    const entries = renderAuditEvent(
      ev('llm_response', { responseText: 'answer' }),
      { deltasSeen: true },
    );
    expect(entries).toHaveLength(1);
    // style 'llm' (not 'response') so this renders as a line, not an empty
    // content block — 'response' would trigger the "(blank)" placeholder
    // meant for a genuinely empty final answer, misleading here since the
    // real text already streamed live a few lines up.
    expect(entries[0]).toMatchObject({
      style: 'llm',
      label: 'llm_response',
      text: '',
    });
  });

  it('renders input as a user-styled block', () => {
    const [entry] = renderAuditEvent(ev('input', { text: 'hello' }), fresh());
    expect(entry).toMatchObject({
      style: 'user',
      label: 'input',
      text: 'hello',
    });
  });

  it('keeps the assignment-complete label for agent_loop_completion', () => {
    const [entry] = renderAuditEvent(
      ev('agent_loop_completion', { summary: 'done' }),
      fresh(),
    );
    expect(entry).toMatchObject({ label: 'assignment complete', text: 'done' });
  });

  it('falls back to a bare event-type line for an unknown type', () => {
    const [entry] = renderAuditEvent(ev('mystery', {}), fresh());
    expect(entry).toMatchObject({ label: 'mystery', text: '' });
  });
});
