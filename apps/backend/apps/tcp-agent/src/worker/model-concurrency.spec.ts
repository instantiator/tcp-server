import type { LlmConfig } from '@tcp/shared';
import {
  endpointKey,
  limitsFor,
  modelConcurrencySchema,
  type ModelConcurrencyConfig,
} from './model-concurrency';

/** A minimal, fully-typed LlmConfig fixture. */
function llm(overrides: Partial<LlmConfig> & { provider: string }): LlmConfig {
  return { model: 'test-model', ...overrides };
}

describe('endpointKey', () => {
  it('uses the catalogue provider id for a remote provider', () => {
    expect(endpointKey(llm({ provider: 'anthropic' }))).toBe('anthropic');
  });

  it('normalises a local provider base URL (case and trailing slash)', () => {
    expect(
      endpointKey(
        llm({ provider: 'lm-studio', baseUrl: 'HTTP://LocalHost:1234/v1/' }),
      ),
    ).toBe('http://localhost:1234/v1');
  });

  it('falls back to the catalogue default base URL when a local provider sets none', () => {
    expect(endpointKey(llm({ provider: 'lm-studio' }))).toBe(
      'http://localhost:1234/v1',
    );
  });

  it('uses the configured base URL for a custom (openai-compatible) provider', () => {
    expect(
      endpointKey(
        llm({
          provider: 'openai-compatible',
          baseUrl: 'http://gpu-box:1234/v1',
        }),
      ),
    ).toBe('http://gpu-box:1234/v1');
  });

  it('throws for an unknown provider', () => {
    expect(() => endpointKey(llm({ provider: 'not-a-provider' }))).toThrow(
      'Unsupported LLM provider: not-a-provider',
    );
  });
});

describe('limitsFor', () => {
  it('pools a local provider (lm-studio) under "local"', () => {
    expect(limitsFor(llm({ provider: 'lm-studio' }), {}).pool).toBe('local');
  });

  it('pools a remote provider (openai) under "remote"', () => {
    expect(limitsFor(llm({ provider: 'openai' }), {}).pool).toBe('remote');
  });

  it('pools a custom provider (openai-compatible) under "local"', () => {
    expect(
      limitsFor(
        llm({ provider: 'openai-compatible', baseUrl: 'http://x:1/v1' }),
        {},
      ).pool,
    ).toBe('local');
  });

  it('applies the built-in pool defaults when the config is empty', () => {
    expect(limitsFor(llm({ provider: 'lm-studio' }), {}).poolLimit).toBe(1);
    expect(limitsFor(llm({ provider: 'openai' }), {}).poolLimit).toBe(4);
  });

  it('treats an explicit null pool as unlimited', () => {
    const config: ModelConcurrencyConfig = { local: null };
    expect(limitsFor(llm({ provider: 'lm-studio' }), config).poolLimit).toBe(
      null,
    );
  });

  it('applies an endpoint override only to its own key', () => {
    const config: ModelConcurrencyConfig = {
      endpoints: { anthropic: 2 },
    };
    expect(
      limitsFor(llm({ provider: 'anthropic' }), config).endpointLimit,
    ).toBe(2);
    expect(limitsFor(llm({ provider: 'openai' }), config).endpointLimit).toBe(
      null,
    );
  });

  it('reports no endpoint limit when none is configured for that key', () => {
    expect(limitsFor(llm({ provider: 'openai' }), {}).endpointLimit).toBeNull();
  });
});

describe('modelConcurrencySchema', () => {
  it('defaults to {} when unset', () => {
    expect(modelConcurrencySchema.validate(undefined)).toEqual({ value: {} });
  });

  // docker-compose passes an unset variable as '' (`${VAR:-}`).
  it('treats an empty value as unset', () => {
    expect(modelConcurrencySchema.validate('')).toEqual({ value: {} });
  });

  it('accepts a valid shape, including null and an endpoint override', () => {
    const raw = JSON.stringify({
      local: 1,
      remote: null,
      endpoints: { anthropic: 2, 'http://gpu-box:1234/v1': 3 },
    });
    const result = modelConcurrencySchema.validate(raw);
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({
      local: 1,
      remote: null,
      endpoints: { anthropic: 2, 'http://gpu-box:1234/v1': 3 },
    });
  });

  it('rejects invalid JSON', () => {
    const result = modelConcurrencySchema.validate('{not json');
    expect(result.error?.message).toContain(
      'MODEL_CONCURRENCY is not valid JSON',
    );
  });

  it('rejects an unknown top-level key', () => {
    const result = modelConcurrencySchema.validate(
      JSON.stringify({ unexpected: true }),
    );
    expect(result.error).toBeDefined();
  });

  it.each([0, -1, 1.5])('rejects a pool limit of %s', (value) => {
    const result = modelConcurrencySchema.validate(
      JSON.stringify({ local: value }),
    );
    expect(result.error).toBeDefined();
  });

  it('rejects a stringly-typed limit', () => {
    const result = modelConcurrencySchema.validate(
      JSON.stringify({ local: '2' }),
    );
    expect(result.error).toBeDefined();
  });
});
