import {
  agentHeading,
  isBlankText,
  JsonDeltaFormatter,
  LogHeadingTracker,
  shortId,
} from './agent-log-format';

describe('shortId', () => {
  it('returns the first 8 hex characters of a UUID', () => {
    expect(shortId('12345678-90ab-cdef-1234-567890abcdef')).toBe('12345678');
  });
});

describe('isBlankText', () => {
  it('is true for empty and whitespace-only text', () => {
    expect(isBlankText('')).toBe(true);
    expect(isBlankText('   \n\t')).toBe(true);
  });

  it('is false for non-blank text', () => {
    expect(isBlankText('hello')).toBe(false);
  });
});

describe('agentHeading', () => {
  it('renders the 5-line identifying block', () => {
    expect(
      agentHeading({
        assignmentId: 'assignment-1',
        assignmentRole: 'Implementer',
        agentId: 'agent-1',
        roleId: 'role-1',
        roleSlug: 'implementer',
      }),
    ).toEqual([
      'Assignment id: assignment-1',
      'Assignment role: Implementer',
      'Agent id: agent-1',
      'Agent role id: role-1',
      'Agent role slug: implementer',
    ]);
  });
});

describe('LogHeadingTracker', () => {
  it('prints on first sight and on change, not on repeat', () => {
    const tracker = new LogHeadingTracker();
    expect(tracker.shouldPrintHeading('agent-1')).toBe(true);
    expect(tracker.shouldPrintHeading('agent-1')).toBe(false);
    expect(tracker.shouldPrintHeading('agent-2')).toBe(true);
    expect(tracker.shouldPrintHeading('agent-1')).toBe(true);
  });
});

describe('JsonDeltaFormatter', () => {
  it('prints the full message history on the first llm_request call', () => {
    const formatter = new JsonDeltaFormatter();
    const result = formatter.format('llm_request', 'agent-1', {
      input: { messages: ['a', 'b'] },
    });
    expect(JSON.parse(result)).toEqual(['a', 'b']);
  });

  it('prints only newly appended messages on subsequent llm_request calls', () => {
    const formatter = new JsonDeltaFormatter();
    formatter.format('llm_request', 'agent-1', {
      input: { messages: ['a', 'b'] },
    });
    const result = formatter.format('llm_request', 'agent-1', {
      input: { messages: ['a', 'b', 'c', 'd'] },
    });
    expect(JSON.parse(result)).toEqual(['c', 'd']);
  });

  it('prints the full payload every time for llm_response', () => {
    const formatter = new JsonDeltaFormatter();
    const first = formatter.format('llm_response', 'agent-1', { text: 'x' });
    const second = formatter.format('llm_response', 'agent-1', { text: 'y' });
    expect(JSON.parse(first)).toEqual({ text: 'x' });
    expect(JSON.parse(second)).toEqual({ text: 'y' });
  });

  it('keeps request/response diff state independent per kind', () => {
    const formatter = new JsonDeltaFormatter();
    formatter.format('llm_request', 'agent-1', {
      input: { messages: ['a'] },
    });
    // A response call for the same agent must not affect the request diff state.
    formatter.format('llm_response', 'agent-1', { text: 'x' });
    const result = formatter.format('llm_request', 'agent-1', {
      input: { messages: ['a', 'b'] },
    });
    expect(JSON.parse(result)).toEqual(['b']);
  });

  it('keeps diff state independent per agent id', () => {
    const formatter = new JsonDeltaFormatter();
    formatter.format('llm_request', 'agent-1', {
      input: { messages: ['a', 'b'] },
    });
    const result = formatter.format('llm_request', 'agent-2', {
      input: { messages: ['x'] },
    });
    expect(JSON.parse(result)).toEqual(['x']);
  });
});
