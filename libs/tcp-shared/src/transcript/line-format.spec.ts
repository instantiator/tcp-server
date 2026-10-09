import { AuditWireEvent } from '@tcp/shared';
import {
  compactionSummary,
  eventLabel,
  inferEntity,
  reasoningText,
  responseText,
  stateChangeText,
  toolName,
} from './line-format';

/** Minimal audit wire event with the given type/payload and no scope. */
function ev(
  eventType: string,
  payload: Record<string, unknown>,
  overrides: Partial<AuditWireEvent> = {},
): AuditWireEvent {
  return {
    timestamp: '2026-07-19T14:03:22.000Z',
    companyId: 'c',
    role: 'r',
    agentId: null,
    assignmentId: null,
    taskId: null,
    eventType: eventType as AuditWireEvent['eventType'],
    payload,
    ...overrides,
  };
}

describe('eventLabel', () => {
  it('suffixes state_change with its entity', () => {
    expect(eventLabel(ev('state_change', { entity: 'task' }))).toBe(
      'state_change:task',
    );
  });

  it('suffixes compaction with its phase', () => {
    expect(eventLabel(ev('compaction', { phase: 'started' }))).toBe(
      'compaction:started',
    );
  });

  it('suffixes tool_call/tool_result with the tool name, bare when absent', () => {
    expect(eventLabel(ev('tool_call', { tool: 'web_search' }))).toBe(
      'tool_call:web_search',
    );
    expect(eventLabel(ev('tool_call', {}))).toBe('tool_call');
  });

  it('leaves llm_request/input/decision bare', () => {
    expect(eventLabel(ev('llm_request', {}))).toBe('llm_request');
    expect(eventLabel(ev('input', { text: 'x' }))).toBe('input');
  });
});

describe('inferEntity (legacy rows without a discriminator)', () => {
  it('uses the explicit entity when present', () => {
    expect(inferEntity(ev('state_change', { entity: 'company' }))).toBe(
      'company',
    );
  });

  it('infers task/assignment/agent from the payload and scope', () => {
    expect(inferEntity(ev('state_change', { taskId: 't' }))).toBe('task');
    expect(inferEntity(ev('state_change', { assignmentId: 'a' }))).toBe(
      'assignment',
    );
    expect(inferEntity(ev('state_change', {}, { agentId: 'ag' }))).toBe(
      'agent',
    );
  });
});

describe('payload extractors', () => {
  it('prefers the enriched fields', () => {
    expect(toolName({ tool: 'grep' })).toBe('grep');
    expect(responseText({ responseText: 'hello' })).toBe('hello');
    expect(reasoningText({ reasoningText: 'because' })).toBe('because');
  });

  it('falls back to the legacy LangGraph message shapes', () => {
    expect(toolName({ output: { kwargs: { name: 'legacy_tool' } } })).toBe(
      'legacy_tool',
    );
    expect(responseText({ output: { content: 'legacy answer' } })).toBe(
      'legacy answer',
    );
    expect(
      reasoningText({
        output: { kwargs: { additional_kwargs: { reasoning_content: 'why' } } },
      }),
    ).toBe('why');
  });
});

describe('compactionSummary and stateChangeText', () => {
  it('summarises a compaction start with strategies and tokens', () => {
    expect(
      compactionSummary({
        phase: 'started',
        strategies: ['trim'],
        tokensBefore: 900,
        windowSize: 1000,
        pct: 90,
      }),
    ).toBe('strategies=[trim], 900/1000 tokens (90%)');
  });

  it('renders a state_change as `status (reason)`, reason optional', () => {
    expect(stateChangeText({ newStatus: 'running', reason: 'resumed' })).toBe(
      'running (resumed)',
    );
    expect(stateChangeText({ newStatus: 'idle' })).toBe('idle');
  });

  it('renders a queued state_change as-is, with no reason', () => {
    expect(stateChangeText({ newStatus: 'queued' })).toBe('queued');
  });

  it('elaborates a rate-limited pause with its next-try time', () => {
    const resumeAfter = '2026-07-19T14:32:00.000Z';
    // Local hh:mm, TZ-independent — matches `parseClockTime`.
    const hhmm = new Date(resumeAfter).toTimeString().slice(0, 5);
    expect(
      stateChangeText({
        newStatus: 'paused',
        reason: 'rate_limited',
        rateLimit: 'rate',
        resumeAfter,
      }),
    ).toBe(`paused (rate limited, next try ${hhmm})`);
  });

  it('elaborates a rate-limited pause with "resume by hand" when resumeAfter is null', () => {
    expect(
      stateChangeText({
        newStatus: 'paused',
        reason: 'rate_limited',
        rateLimit: 'quota',
        resumeAfter: null,
      }),
    ).toBe('paused (rate limited, resume by hand)');
  });

  it('elaborates a rate-limited pause with "resume by hand" when resumeAfter is absent', () => {
    expect(
      stateChangeText({ newStatus: 'paused', reason: 'rate_limited' }),
    ).toBe('paused (rate limited, resume by hand)');
  });

  it('leaves an ordinary paused reason untouched', () => {
    expect(stateChangeText({ newStatus: 'paused', reason: 'user_input' })).toBe(
      'paused (user_input)',
    );
  });
});
