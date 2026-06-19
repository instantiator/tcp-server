import { ChatOpenAI } from '@langchain/openai';
import { buildChatModel } from './llm-factory';

describe('buildChatModel', () => {
  it('returns a ChatOpenAI instance for lm-studio provider', () => {
    const model = buildChatModel({
      provider: 'lm-studio',
      model: 'qwen3-5b',
      baseUrl: 'http://localhost:1234/v1',
    });
    expect(model).toBeInstanceOf(ChatOpenAI);
  });

  it('returns a ChatOpenAI instance for openai provider', () => {
    const model = buildChatModel({
      provider: 'openai',
      model: 'gpt-4o',
      apiKeyEnvVar: 'OPENAI_API_KEY',
    });
    expect(model).toBeInstanceOf(ChatOpenAI);
  });

  it('instantiates without throwing when apiKeyEnvVar is set in env', () => {
    process.env['TEST_LLM_KEY'] = 'test-secret';
    expect(() =>
      buildChatModel({
        provider: 'openai',
        model: 'gpt-4o',
        apiKeyEnvVar: 'TEST_LLM_KEY',
      }),
    ).not.toThrow();
    delete process.env['TEST_LLM_KEY'];
  });

  it('throws for an unsupported provider', () => {
    expect(() =>
      buildChatModel({ provider: 'gemini', model: 'flash' }),
    ).toThrow('Unsupported LLM provider: gemini');
  });
});
