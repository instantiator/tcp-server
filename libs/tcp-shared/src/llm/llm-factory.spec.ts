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

  it('builds a ChatOpenAI for the lm-studio provider', () => {
    expect(buildChatModel(baseConfig)).toBeInstanceOf(ChatOpenAI);
  });

  it('builds a ChatOpenAI for the openai provider', () => {
    const model = buildChatModel({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'OPENAI_API_KEY',
    });
    expect(model).toBeInstanceOf(ChatOpenAI);
  });

  it('resolves apiKey as the name of an environment variable', () => {
    process.env['TEST_LLM_KEY'] = 'test-secret';
    expect(() =>
      buildChatModel({
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'TEST_LLM_KEY',
      }),
    ).not.toThrow();
    delete process.env['TEST_LLM_KEY'];
  });
});
