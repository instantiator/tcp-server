import type { LlmConfig } from '../models/LlmConfig.model';
import { resolveEmbeddingConfig } from './resolve-embedding-config';

const config = (model: string): LlmConfig => ({
  provider: 'lm-studio',
  model,
});

describe('resolveEmbeddingConfig', () => {
  it('uses the company value when set', () => {
    expect(
      resolveEmbeddingConfig(
        { embeddingConfig: config('company') },
        config('env'),
      )?.model,
    ).toBe('company');
  });

  it('falls through to the env fallback when the company has no embeddingConfig', () => {
    expect(
      resolveEmbeddingConfig({ embeddingConfig: null }, config('env'))?.model,
    ).toBe('env');
  });

  it('returns undefined when nothing is configured anywhere', () => {
    expect(resolveEmbeddingConfig(null, null)).toBeUndefined();
  });

  it('treats a null company the same as no embeddingConfig', () => {
    expect(resolveEmbeddingConfig(null, config('env'))?.model).toBe('env');
  });
});
