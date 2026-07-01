import { ChatOpenAI } from '@langchain/openai';
import { DEFAULT_LLM_TIMEOUT_MS } from '../config/defaults';
import type { LlmConfig } from '../models/LlmConfig.model';
import { buildChatModel } from './llm-factory';

const baseConfig: LlmConfig = {
  provider: 'lm-studio',
  model: 'qwen/qwen3.5-9b',
  baseUrl: 'http://localhost:1234/v1',
};

describe('buildChatModel', () => {
  it('uses timeoutMs when set', () => {
    const model = buildChatModel({ ...baseConfig, timeoutMs: 5_000 });
    expect((model as ChatOpenAI).timeout).toBe(5_000);
  });

  it('falls back to the default timeout when timeoutMs is undefined', () => {
    const model = buildChatModel(baseConfig);
    expect((model as ChatOpenAI).timeout).toBe(DEFAULT_LLM_TIMEOUT_MS);
  });

  it('falls back to the default timeout when timeoutMs is an empty string (NestJS ConfigService can surface unset env vars this way)', () => {
    const model = buildChatModel({
      ...baseConfig,
      timeoutMs: '' as unknown as number,
    });
    expect((model as ChatOpenAI).timeout).toBe(DEFAULT_LLM_TIMEOUT_MS);
  });

  it('throws for an unrecognised provider', () => {
    expect(() =>
      buildChatModel({ ...baseConfig, provider: 'unknown' }),
    ).toThrow('Unsupported LLM provider: unknown');
  });
});
