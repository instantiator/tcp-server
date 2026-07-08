import type { LlmConfig } from '../models/LlmConfig.model';
import { resolveLlmConfig } from './resolve-llm-config';

const config = (model: string): LlmConfig => ({
  provider: 'lm-studio',
  model,
});

describe('resolveLlmConfig', () => {
  it('uses the role value when set', () => {
    expect(
      resolveLlmConfig(
        { llmConfig: config('role') },
        { llmConfig: config('company') },
        config('env'),
      )?.model,
    ).toBe('role');
  });

  it('falls through to company when role has no llmConfig', () => {
    expect(
      resolveLlmConfig(
        { llmConfig: null },
        { llmConfig: config('company') },
        config('env'),
      )?.model,
    ).toBe('company');
  });

  it('falls through to the env fallback when neither role nor company is set', () => {
    expect(
      resolveLlmConfig({ llmConfig: null }, { llmConfig: null }, config('env'))
        ?.model,
    ).toBe('env');
  });

  it('returns undefined when nothing is configured anywhere', () => {
    expect(resolveLlmConfig(null, null, null)).toBeUndefined();
  });

  it('treats null role and company the same as no llmConfig', () => {
    expect(resolveLlmConfig(null, null, config('env'))?.model).toBe('env');
  });
});
