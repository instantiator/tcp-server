import type { ProviderTemplate } from '@tcp/shared/llm/provider-catalogue';
import { lookupContextWindow } from './context-lookup';

/** Builds a `fetch`-shaped stub that resolves with the given JSON body. */
function jsonFetch(body: unknown, ok = true): typeof fetch {
  const response = {
    ok,
    status: ok ? 200 : 404,
    json: () => Promise.resolve(body),
  };
  return (() => Promise.resolve(response)) as unknown as typeof fetch;
}

/** A `fetch`-shaped stub that always rejects, as a dead server would. */
function failingFetch(message: string): typeof fetch {
  return () => Promise.reject(new Error(message));
}

function template(overrides: Partial<ProviderTemplate>): ProviderTemplate {
  return {
    id: 'openai',
    name: 'OpenAI',
    kind: 'remote',
    baseUrl: 'https://api.openai.com/v1',
    fields: ['apiKey'],
    ...overrides,
  };
}

describe('lookupContextWindow', () => {
  it('reads LM Studio loaded_context_length', async () => {
    const fetchFn = jsonFetch({
      loaded_context_length: 8192,
      max_context_length: 32768,
    });
    const result = await lookupContextWindow(
      template({ id: 'lm-studio', name: 'LM Studio' }),
      'google/gemma-4-e4b',
      'http://localhost:1234/v1',
      fetchFn,
    );
    expect(result).toEqual({ tokens: 8192, source: 'LM Studio' });
  });

  it('falls back to LM Studio max_context_length when not loaded', async () => {
    const fetchFn = jsonFetch({ max_context_length: 32768 });
    const result = await lookupContextWindow(
      template({ id: 'lm-studio', name: 'LM Studio' }),
      'google/gemma-4-e4b',
      'http://localhost:1234/v1',
      fetchFn,
    );
    expect(result).toEqual({ tokens: 32768, source: 'LM Studio' });
  });

  it('reads the Ollama model_info context length', async () => {
    const fetchFn = jsonFetch({
      model_info: { 'gemma4.context_length': 8192 },
    });
    const result = await lookupContextWindow(
      template({ id: 'ollama', name: 'Ollama' }),
      'gemma4:e4b',
      'http://localhost:11434/v1',
      fetchFn,
    );
    expect(result).toEqual({ tokens: 8192, source: 'Ollama' });
  });

  it('reads models.dev for a provider with a modelsDevId', async () => {
    const fetchFn = jsonFetch({
      openai: {
        models: { 'gpt-5-mini': { limit: { context: 400000 } } },
      },
    });
    const result = await lookupContextWindow(
      template({ modelsDevId: 'openai' }),
      'gpt-5-mini',
      'https://api.openai.com/v1',
      fetchFn,
    );
    expect(result).toEqual({ tokens: 400000, source: 'models.dev' });
  });

  it('returns undefined when the provider has no lookup source', async () => {
    let called = false;
    const fetchFn = (() => {
      called = true;
      return Promise.reject(new Error('should not be called'));
    }) as unknown as typeof fetch;

    const result = await lookupContextWindow(
      template({ id: 'openai-compatible', kind: 'custom' }),
      'whatever',
      'http://localhost:8000/v1',
      fetchFn,
    );
    expect(result).toBeUndefined();
    expect(called).toBe(false);
  });

  it('returns undefined when the request fails', async () => {
    const fetchFn = failingFetch('network down');
    const result = await lookupContextWindow(
      template({ id: 'lm-studio', name: 'LM Studio' }),
      'google/gemma-4-e4b',
      'http://localhost:1234/v1',
      fetchFn,
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when the response is not ok', async () => {
    const fetchFn = jsonFetch({}, false);
    const result = await lookupContextWindow(
      template({ id: 'lm-studio', name: 'LM Studio' }),
      'missing-model',
      'http://localhost:1234/v1',
      fetchFn,
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when models.dev has no entry for the model', async () => {
    const fetchFn = jsonFetch({ openai: { models: {} } });
    const result = await lookupContextWindow(
      template({ modelsDevId: 'openai' }),
      'unknown-model',
      'https://api.openai.com/v1',
      fetchFn,
    );
    expect(result).toBeUndefined();
  });
});
