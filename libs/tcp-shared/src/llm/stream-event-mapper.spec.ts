import { AIMessage } from '@langchain/core/messages';
import { AuditEventType } from '../models/AuditEvent.model';
import type { StreamDelta } from '../events/wire-events';
import {
  enrichedAuditForEvent,
  mapStreamDeltas,
  StreamEventLike,
} from './stream-event-mapper';

const AGENT = 'agent-1';

/** Strips the per-call timestamp so tests can assert on channel + delta alone. */
function withoutTimestamps(
  deltas: StreamDelta[],
): Omit<StreamDelta, 'timestamp'>[] {
  return deltas.map((delta) => {
    const { timestamp, ...rest } = delta;
    void timestamp;
    return rest;
  });
}

describe('mapStreamDeltas', () => {
  it('maps a stream chunk with only response content to a single response delta', () => {
    const event: StreamEventLike = {
      event: 'on_chat_model_stream',
      data: { chunk: { content: 'Hello' } },
    };
    expect(withoutTimestamps(mapStreamDeltas(event, AGENT))).toEqual([
      { type: 'stream', agentId: AGENT, channel: 'response', delta: 'Hello' },
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
    expect(withoutTimestamps(mapStreamDeltas(event, AGENT))).toEqual([
      {
        type: 'stream',
        agentId: AGENT,
        channel: 'reasoning',
        delta: 'thinking',
      },
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
    expect(withoutTimestamps(mapStreamDeltas(event, AGENT))).toEqual([
      { type: 'stream', agentId: AGENT, channel: 'response', delta: 'Hi' },
      { type: 'stream', agentId: AGENT, channel: 'reasoning', delta: 'why' },
    ]);
  });

  it('yields nothing for an empty stream chunk', () => {
    expect(
      mapStreamDeltas(
        { event: 'on_chat_model_stream', data: { chunk: { content: '' } } },
        AGENT,
      ),
    ).toEqual([]);
  });

  it('ignores non-string (array) content deltas', () => {
    const event: StreamEventLike = {
      event: 'on_chat_model_stream',
      data: { chunk: { content: [{ type: 'text', text: 'x' }] } },
    };
    expect(mapStreamDeltas(event, AGENT)).toEqual([]);
  });

  it('yields nothing for lifecycle (non-stream) events', () => {
    expect(mapStreamDeltas({ event: 'on_chat_model_start' }, AGENT)).toEqual(
      [],
    );
    expect(mapStreamDeltas({ event: 'on_tool_start' }, AGENT)).toEqual([]);
  });

  it('stamps every delta with an ISO timestamp', () => {
    const [delta] = mapStreamDeltas(
      { event: 'on_chat_model_stream', data: { chunk: { content: 'x' } } },
      AGENT,
    );
    expect(delta.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('enrichedAuditForEvent', () => {
  it('maps on_chat_model_start to an llm_request row', () => {
    expect(
      enrichedAuditForEvent({ event: 'on_chat_model_start', data: {} }),
    ).toEqual({ eventType: AuditEventType.LlmRequest, payload: {} });
  });

  it('maps on_tool_start to a tool_call row carrying the tool name and input', () => {
    expect(
      enrichedAuditForEvent({
        event: 'on_tool_start',
        name: 'web_search',
        data: { input: { query: 'x' } },
      }),
    ).toEqual({
      eventType: AuditEventType.ToolCall,
      payload: { tool: 'web_search', input: { query: 'x' } },
    });
  });

  it('maps on_tool_end to a tool_result row carrying the tool name and output', () => {
    expect(
      enrichedAuditForEvent({
        event: 'on_tool_end',
        name: 'web_search',
        data: { output: 'results' },
      }),
    ).toEqual({
      eventType: AuditEventType.ToolResult,
      payload: { tool: 'web_search', output: 'results' },
    });
  });

  it('maps on_chat_model_end to an llm_response row with normalized response/reasoning text', () => {
    const output = new AIMessage({
      content: 'the answer',
      additional_kwargs: { reasoning_content: 'because' },
    });
    const result = enrichedAuditForEvent({
      event: 'on_chat_model_end',
      data: { output },
    });
    expect(result?.eventType).toBe(AuditEventType.LlmResponse);
    expect(result?.payload).toMatchObject({
      responseText: 'the answer',
      reasoningText: 'because',
    });
    expect(result?.payload.output).toBe(output);
  });

  it('returns null for non-lifecycle events', () => {
    expect(enrichedAuditForEvent({ event: 'on_chat_model_stream' })).toBeNull();
    expect(enrichedAuditForEvent({ event: 'on_chain_start' })).toBeNull();
  });

  it('includes usage in the on_chat_model_end payload when the provider reported it and an llm identity is given', () => {
    const output = new AIMessage({
      content: 'the answer',
      // usage_metadata is set after construction — AIMessage's constructor
      // type doesn't accept it directly, but LangChain attaches it as a
      // plain property on real provider responses.
    });
    Object.assign(output, {
      usage_metadata: { input_tokens: 12, output_tokens: 4 },
    });
    const result = enrichedAuditForEvent(
      { event: 'on_chat_model_end', data: { output } },
      { provider: 'lm-studio', model: 'qwen3-5b' },
    );
    expect(result?.payload.usage).toEqual({
      provider: 'lm-studio',
      model: 'qwen3-5b',
      inputTokens: 12,
      outputTokens: 4,
    });
    expect(result?.payload).not.toHaveProperty('untrackedProvider');
  });

  it('names the provider instead of usage when it reports none, so the gap can be flagged', () => {
    const output = new AIMessage({ content: 'the answer' });
    const result = enrichedAuditForEvent(
      { event: 'on_chat_model_end', data: { output } },
      { provider: 'lm-studio', model: 'qwen3-5b' },
    );
    expect(result?.payload).not.toHaveProperty('usage');
    expect(result?.payload.untrackedProvider).toBe('lm-studio');
  });

  it('omits usage when no llm identity is passed, even if the provider reported it', () => {
    const output = new AIMessage({ content: 'the answer' });
    Object.assign(output, {
      usage_metadata: { input_tokens: 12, output_tokens: 4 },
    });
    const result = enrichedAuditForEvent({
      event: 'on_chat_model_end',
      data: { output },
    });
    expect(result?.payload).not.toHaveProperty('usage');
    expect(result?.payload).not.toHaveProperty('untrackedProvider');
  });
});
