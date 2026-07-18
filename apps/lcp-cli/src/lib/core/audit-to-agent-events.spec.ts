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

  it('maps an llm_response reasoning_content to a reasoning block before the response', () => {
    const events = mapAuditHistoryToEvents([
      {
        timestamp: 't1',
        eventType: 'llm_response',
        payload: {
          output: {
            content: 'The answer.',
            kwargs: {
              additional_kwargs: { reasoning_content: 'Let me think...' },
            },
          },
        },
      },
    ]);
    expect(events).toEqual([
      {
        kind: 'reasoning',
        timestamp: 't1',
        data: { delta: 'Let me think...' },
      },
      { kind: 'response', timestamp: 't1', data: { delta: 'The answer.' } },
    ]);
  });

  it('maps a tool-call turn (reasoning_content but empty content) to reasoning alone', () => {
    const events = mapAuditHistoryToEvents([
      {
        timestamp: 't1',
        eventType: 'llm_response',
        payload: {
          output: {
            content: '',
            kwargs: {
              additional_kwargs: { reasoning_content: 'I should call a tool.' },
            },
          },
        },
      },
    ]);
    expect(events).toEqual([
      {
        kind: 'reasoning',
        timestamp: 't1',
        data: { delta: 'I should call a tool.' },
      },
    ]);
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

  it('skips llm_request/tool_call/decision rows and content-less tool_result rows', () => {
    const events = mapAuditHistoryToEvents([
      { timestamp: 't1', eventType: 'llm_request', payload: {} },
      // tool_call records only the input, not the tool name — nothing to show.
      { timestamp: 't2', eventType: 'tool_call', payload: { input: {} } },
      // tool_result with no name (malformed / missing output) is skipped too.
      { timestamp: 't3', eventType: 'tool_result', payload: {} },
      { timestamp: 't4', eventType: 'decision', payload: {} },
    ]);
    expect(events).toEqual([]);
  });

  it('maps a tool_result to an llm tool_complete activity, reading the name from output.kwargs.name', () => {
    const events = mapAuditHistoryToEvents([
      {
        timestamp: 't1',
        eventType: 'tool_result',
        payload: {
          input: { input: '{}' },
          output: { kwargs: { name: 'storage__list_working_files' } },
        },
      },
    ]);
    expect(events).toEqual([
      {
        kind: 'llm',
        timestamp: 't1',
        data: {
          activity: 'tool_complete',
          tool: 'storage__list_working_files',
        },
      },
    ]);
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
