import { ConfigService } from '@nestjs/config';
import { resolveEnvLlmConfig } from './resolve-env-llm-config';

function makeConfig(values: Record<string, unknown>): ConfigService {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

describe('resolveEnvLlmConfig', () => {
  it('returns null when LLM_PROVIDER is not set', () => {
    const config = makeConfig({ LLM_MODEL: 'qwen3-5b' });
    expect(resolveEnvLlmConfig(config)).toBeNull();
  });

  it('returns null when LLM_MODEL is not set', () => {
    const config = makeConfig({ LLM_PROVIDER: 'lm-studio' });
    expect(resolveEnvLlmConfig(config)).toBeNull();
  });

  it('builds an LlmConfig from env vars when both provider and model are set', () => {
    const config = makeConfig({
      LLM_PROVIDER: 'lm-studio',
      LLM_MODEL: 'qwen3-5b',
      LLM_BASE_URL: 'http://localhost:1234/v1',
      LLM_API_KEY: 'test-key',
      LLM_CONTEXT_WINDOW: 8192,
      LLM_TIMEOUT_MS: 1_800_000,
    });

    expect(resolveEnvLlmConfig(config)).toEqual({
      provider: 'lm-studio',
      model: 'qwen3-5b',
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'test-key',
      contextWindow: 8192,
      timeoutMs: 1_800_000,
    });
  });
});
