import { isLlmUsage, usageFromMessage } from './llm-usage';

const LLM = { provider: 'lm-studio', model: 'qwen3-5b' };

describe('usageFromMessage', () => {
  it('reads input/output token counts off usage_metadata', () => {
    const message = {
      usage_metadata: { input_tokens: 10, output_tokens: 5 },
    };
    expect(usageFromMessage(message, LLM)).toEqual({
      provider: 'lm-studio',
      model: 'qwen3-5b',
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  it('returns undefined when usage_metadata is absent', () => {
    expect(usageFromMessage({}, LLM)).toBeUndefined();
    expect(usageFromMessage(undefined, LLM)).toBeUndefined();
    expect(usageFromMessage(null, LLM)).toBeUndefined();
  });

  it('returns undefined when both counts are non-numbers', () => {
    const message = {
      usage_metadata: { input_tokens: 'ten', output_tokens: undefined },
    };
    expect(usageFromMessage(message, LLM)).toBeUndefined();
  });

  it('defaults a missing count to 0 when the other is a number', () => {
    const message = { usage_metadata: { input_tokens: 10 } };
    expect(usageFromMessage(message, LLM)).toEqual({
      provider: 'lm-studio',
      model: 'qwen3-5b',
      inputTokens: 10,
      outputTokens: 0,
    });
  });

  it('accepts a zero-token report as a defined usage (the call happened, just used none)', () => {
    const message = {
      usage_metadata: { input_tokens: 0, output_tokens: 0 },
    };
    expect(usageFromMessage(message, LLM)).toEqual({
      provider: 'lm-studio',
      model: 'qwen3-5b',
      inputTokens: 0,
      outputTokens: 0,
    });
  });
});

describe('isLlmUsage', () => {
  it('accepts a well-formed LlmUsage', () => {
    expect(
      isLlmUsage({
        provider: 'lm-studio',
        model: 'qwen3-5b',
        inputTokens: 1,
        outputTokens: 2,
      }),
    ).toBe(true);
  });

  it('rejects missing, non-object, and wrongly-typed values', () => {
    expect(isLlmUsage(undefined)).toBe(false);
    expect(isLlmUsage(null)).toBe(false);
    expect(isLlmUsage('usage')).toBe(false);
    expect(isLlmUsage({ provider: 'x', model: 'y', inputTokens: '1' })).toBe(
      false,
    );
    expect(isLlmUsage({ provider: 'x', model: 'y', inputTokens: 1 })).toBe(
      false,
    ); // outputTokens missing
  });
});
