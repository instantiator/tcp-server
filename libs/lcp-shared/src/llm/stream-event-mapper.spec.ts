import { AgentEvent } from '../events/agent-events';
import { mapStreamEvent, StreamEventLike } from './stream-event-mapper';

/** Strips the per-call timestamp so tests can assert on kind + data alone. */
function withoutTimestamps(
  events: AgentEvent[],
): Omit<AgentEvent, 'timestamp'>[] {
  return events.map((event) => {
    const { timestamp, ...rest } = event;
    void timestamp;
    return rest;
  });
}

describe('mapStreamEvent', () => {
  it('maps on_chat_model_start to an llm request_started event', () => {
    expect(
      withoutTimestamps(mapStreamEvent({ event: 'on_chat_model_start' })),
    ).toEqual([{ kind: 'llm', data: { activity: 'request_started' } }]);
  });

  it('maps on_chat_model_end to an llm request_complete event', () => {
    expect(
      withoutTimestamps(mapStreamEvent({ event: 'on_chat_model_end' })),
    ).toEqual([{ kind: 'llm', data: { activity: 'request_complete' } }]);
  });

  it('maps on_tool_start to an llm tool_started event carrying the tool name', () => {
    expect(
      withoutTimestamps(
        mapStreamEvent({
          event: 'on_tool_start',
          name: 'request_agent_consultation',
        }),
      ),
    ).toEqual([
      {
        kind: 'llm',
        data: { activity: 'tool_started', tool: 'request_agent_consultation' },
      },
    ]);
  });

  it('maps on_tool_end to an llm tool_complete event carrying the tool name', () => {
    expect(
      withoutTimestamps(
        mapStreamEvent({ event: 'on_tool_end', name: 'complete_task' }),
      ),
    ).toEqual([
      {
        kind: 'llm',
        data: { activity: 'tool_complete', tool: 'complete_task' },
      },
    ]);
  });

  it('maps a stream chunk with only response content to a single response delta', () => {
    const event: StreamEventLike = {
      event: 'on_chat_model_stream',
      data: { chunk: { content: 'Hello' } },
    };
    expect(withoutTimestamps(mapStreamEvent(event))).toEqual([
      { kind: 'response', data: { delta: 'Hello' } },
    ]);
  });

  it('maps a stream chunk with reasoning content to a reasoning delta', () => {
    const event: StreamEventLike = {
      event: 'on_chat_model_stream',
      data: {
        chunk: {
          content: '',
          additional_kwargs: { reasoning_content: 'thinking' },
        },
      },
    };
    expect(withoutTimestamps(mapStreamEvent(event))).toEqual([
      { kind: 'reasoning', data: { delta: 'thinking' } },
    ]);
  });

  it('emits both response and reasoning deltas when a chunk carries both', () => {
    const event: StreamEventLike = {
      event: 'on_chat_model_stream',
      data: {
        chunk: {
          content: 'Hi',
          additional_kwargs: { reasoning_content: 'why' },
        },
      },
    };
    expect(withoutTimestamps(mapStreamEvent(event))).toEqual([
      { kind: 'response', data: { delta: 'Hi' } },
      { kind: 'reasoning', data: { delta: 'why' } },
    ]);
  });

  it('yields nothing for an empty stream chunk', () => {
    expect(
      mapStreamEvent({
        event: 'on_chat_model_stream',
        data: { chunk: { content: '' } },
      }),
    ).toEqual([]);
  });

  it('ignores non-string (array) content deltas', () => {
    const event: StreamEventLike = {
      event: 'on_chat_model_stream',
      data: { chunk: { content: [{ type: 'text', text: 'x' }] } },
    };
    expect(mapStreamEvent(event)).toEqual([]);
  });

  it('yields nothing for unmapped event kinds', () => {
    expect(mapStreamEvent({ event: 'on_chain_start' })).toEqual([]);
  });

  it('stamps every emitted event with an ISO timestamp', () => {
    const [event] = mapStreamEvent({ event: 'on_chat_model_start' });
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
