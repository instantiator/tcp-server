import { ConfigService } from '@nestjs/config';
import { resolveEnvEmbeddingConfig } from './resolve-env-embedding-config';

function makeConfig(values: Record<string, unknown>): ConfigService {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

describe('resolveEnvEmbeddingConfig', () => {
  it('returns null when EMBEDDING_PROVIDER is not set', () => {
    const config = makeConfig({ EMBEDDING_MODEL: 'nomic-embed-text' });
    expect(resolveEnvEmbeddingConfig(config)).toBeNull();
  });

  it('returns null when EMBEDDING_MODEL is not set', () => {
    const config = makeConfig({ EMBEDDING_PROVIDER: 'lm-studio' });
    expect(resolveEnvEmbeddingConfig(config)).toBeNull();
  });

  it('builds an LlmConfig from env vars when both provider and model are set', () => {
    const config = makeConfig({
      EMBEDDING_PROVIDER: 'lm-studio',
      EMBEDDING_MODEL: 'nomic-embed-text',
      EMBEDDING_BASE_URL: 'http://localhost:1234/v1',
      EMBEDDING_API_KEY: 'test-key',
    });

    expect(resolveEnvEmbeddingConfig(config)).toEqual({
      provider: 'lm-studio',
      model: 'nomic-embed-text',
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'test-key',
    });
  });
});
