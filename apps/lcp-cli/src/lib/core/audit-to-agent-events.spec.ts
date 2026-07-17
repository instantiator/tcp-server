import { mapAuditHistoryToEvents } from './audit-to-agent-events';

describe('mapAuditHistoryToEvents', () => {
  it('maps state_change to agent_status', () => {
    const events = mapAuditHistoryToEvents([
      {
        timestamp: 't1',
        eventType: 'state_change',
        payload: { newStatus: 'running', reason: 'started' },
      },
    ]);
    expect(events).toEqual([
      {
        kind: 'agent_status',
        timestamp: 't1',
        data: { status: 'running', reason: 'started' },
      },
    ]);
  });

  it('maps llm_response with string content to a response block', () => {
    const events = mapAuditHistoryToEvents([
      {
        timestamp: 't1',
        eventType: 'llm_response',
        payload: { output: { content: 'Here is the answer.' } },
      },
    ]);
    expect(events).toEqual([
      {
        kind: 'response',
        timestamp: 't1',
        data: { delta: 'Here is the answer.' },
      },
    ]);
  });

  it('maps llm_response with content-block array output', () => {
    const events = mapAuditHistoryToEvents([
      {
        timestamp: 't1',
        eventType: 'llm_response',
        payload: {
          output: { content: [{ type: 'text', text: 'Block answer.' }] },
        },
      },
    ]);
    expect(events).toEqual([
      { kind: 'response', timestamp: 't1', data: { delta: 'Block answer.' } },
    ]);
  });

  it('skips an llm_response row with no reconstructable text', () => {
    const events = mapAuditHistoryToEvents([
      { timestamp: 't1', eventType: 'llm_response', payload: {} },
    ]);
    expect(events).toEqual([]);
  });

  it('passes agent_loop_completion through as-is', () => {
    const events = mapAuditHistoryToEvents([
      {
        timestamp: 't1',
        eventType: 'agent_loop_completion',
        payload: { summary: 'Task completed.' },
      },
    ]);
    expect(events).toEqual([
      {
        kind: 'agent_loop_completion',
        timestamp: 't1',
        data: { summary: 'Task completed.' },
      },
    ]);
  });

  it('skips llm_request/tool_call/tool_result/decision rows (no reconstructable content)', () => {
    const events = mapAuditHistoryToEvents([
      { timestamp: 't1', eventType: 'llm_request', payload: {} },
      { timestamp: 't2', eventType: 'tool_call', payload: {} },
      { timestamp: 't3', eventType: 'tool_result', payload: {} },
      { timestamp: 't4', eventType: 'decision', payload: {} },
    ]);
    expect(events).toEqual([]);
  });

  it('preserves row order', () => {
    const events = mapAuditHistoryToEvents([
      {
        timestamp: 't1',
        eventType: 'state_change',
        payload: { newStatus: 'running' },
      },
      {
        timestamp: 't2',
        eventType: 'llm_response',
        payload: { output: { content: 'done' } },
      },
    ]);
    expect(events.map((e) => e.kind)).toEqual(['agent_status', 'response']);
  });
});
