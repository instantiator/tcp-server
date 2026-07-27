import { isContextLengthError } from './context-length-error';

describe('isContextLengthError', () => {
  const cases: [string, string, boolean][] = [
    [
      'OpenAI-style',
      "This model's maximum context length is 8192 tokens",
      true,
    ],
    [
      'literal error observed in the field',
      'Context size has been exceeded',
      true,
    ],
    ['generic context_length_exceeded code', 'context_length_exceeded', true],
    [
      'LM Studio-style',
      'Trying to keep the first 8192 tokens... context window',
      true,
    ],
    ['too-many-tokens phrasing', 'Too many tokens in request', true],
    ['unrelated network error', 'ECONNREFUSED 127.0.0.1:1234', false],
    ['unrelated 500 error', 'Internal server error', false],
  ];

  it.each(cases)('%s -> %p', (_label, message, expected) => {
    expect(isContextLengthError(new Error(message))).toBe(expected);
  });

  it('handles non-Error thrown values via String() coercion', () => {
    expect(isContextLengthError('context_length_exceeded')).toBe(true);
    expect(isContextLengthError({ toString: () => 'unrelated' })).toBe(false);
  });
});
