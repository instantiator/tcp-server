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

  describe('tool summary', () => {
    const langchainResult = (kwargs: Record<string, unknown>) =>
      ev('tool_result', {
        tool: 'tasks__create_plan',
        output: { lc: 1, type: 'constructor', kwargs },
      });

    it('gives a tool call its name only', () => {
      const [entry] = renderAuditEvent(
        ev('tool_call', { tool: 'web_search', input: { q: 'x' } }),
        fresh(),
      );
      expect(entry.tool).toEqual({ name: 'web_search' });
    });

    it('reads status and content from a LangChain ToolMessage, leaving the JSON intact', () => {
      const e = langchainResult({ status: 'success', content: 'Plan created' });
      const [entry] = renderAuditEvent(e, fresh());
      expect(entry.tool).toEqual({
        name: 'tasks__create_plan',
        status: 'success',
        content: 'Plan created',
      });
      expect(JSON.parse(entry.text)).toEqual({
        tool: 'tasks__create_plan',
        output: e.payload['output'],
      });
    });

    it('takes a string output as the content', () => {
      const [entry] = renderAuditEvent(
        ev('tool_result', { tool: 't', output: 'done' }),
        fresh(),
      );
      expect(entry.tool).toEqual({ name: 't', content: 'done' });
    });

    it('joins array content from its text parts', () => {
      const [entry] = renderAuditEvent(
        langchainResult({
          content: [
            { type: 'text', text: 'a' },
            { type: 'image' },
            { type: 'text', text: 'b' },
          ],
        }),
        fresh(),
      );
      expect(entry.tool).toEqual({ name: 'tasks__create_plan', content: 'ab' });
    });

    it('gives only the name for an output it cannot read', () => {
      const [entry] = renderAuditEvent(
        ev('tool_result', { tool: 7, output: { kwargs: 'nope' } }),
        fresh(),
      );
      expect(entry.tool).toEqual({ name: 'unknown' });
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
