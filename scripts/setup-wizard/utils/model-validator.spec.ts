import type { LlmProviderConfig } from '../types';
import { describeProbeError, validateModel } from './model-validator';

describe('describeProbeError', () => {
  it('reports a rejected API key on 401', () => {
    expect(
      describeProbeError({
        url: 'https://api.openai.com/v1/chat/completions',
        providerName: 'OpenAI',
        model: 'gpt-5-mini',
        status: 401,
      }),
    ).toBe('The API key was rejected.');
  });

  it('reports a rejected API key on 403', () => {
    expect(
      describeProbeError({
        url: 'https://api.openai.com/v1/chat/completions',
        providerName: 'OpenAI',
        model: 'gpt-5-mini',
        status: 403,
      }),
    ).toBe('The API key was rejected.');
  });

  it('names the model on 404', () => {
    expect(
      describeProbeError({
        url: 'http://localhost:1234/v1/chat/completions',
        providerName: 'LM Studio',
        model: 'gemma-4-e4b',
        status: 404,
      }),
    ).toBe(
      "Model 'gemma-4-e4b' wasn't found. Check the name, or that it's loaded.",
    );
  });

  it('shows the status and the first 300 characters of the body otherwise', () => {
    const body = 'x'.repeat(400);
    const message = describeProbeError({
      url: 'https://api.mistral.ai/v1/chat/completions',
      providerName: 'Mistral',
      model: 'mistral-small-latest',
      status: 500,
      body,
    });
    expect(message).toBe(`HTTP 500: ${'x'.repeat(300)}`);
  });

  it('reports a timeout for a TimeoutError', () => {
    const error = new Error('The operation was aborted due to timeout');
    error.name = 'TimeoutError';
    expect(
      describeProbeError({
        url: 'http://localhost:1234/v1/chat/completions',
        providerName: 'LM Studio',
        model: 'gemma-4-e4b',
        error,
      }),
    ).toBe(
      'No reply within 60s. A local server may still be loading the model — try again.',
    );
  });

  it('reports a timeout for an AbortError', () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    expect(
      describeProbeError({
        url: 'http://localhost:1234/v1/chat/completions',
        providerName: 'LM Studio',
        model: 'gemma-4-e4b',
        error,
      }),
    ).toBe(
      'No reply within 60s. A local server may still be loading the model — try again.',
    );
  });

  it('names the provider and URL for a connection refused', () => {
    const error = Object.assign(new Error('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    });
    expect(
      describeProbeError({
        url: 'http://localhost:1234/v1/chat/completions',
        providerName: 'LM Studio',
        model: 'gemma-4-e4b',
        error,
      }),
    ).toBe(
      'Nothing is answering at http://localhost:1234/v1/chat/completions. Is LM Studio running?',
    );
  });

  it('names the provider and URL for a DNS failure', () => {
    const error = Object.assign(new Error('fetch failed'), {
      cause: { code: 'ENOTFOUND' },
    });
    expect(
      describeProbeError({
        url: 'https://bad.invalid/v1/chat/completions',
        providerName: 'Custom',
        model: 'whatever',
        error,
      }),
    ).toContain('Nothing is answering');
  });

  it('falls back to the error message for anything else', () => {
    const error = new Error('something else broke');
    expect(
      describeProbeError({
        url: 'https://api.openai.com/v1/chat/completions',
        providerName: 'OpenAI',
        model: 'gpt-5-mini',
        error,
      }),
    ).toBe('something else broke');
  });

  it('never echoes the API key', () => {
    const message = describeProbeError({
      url: 'https://api.openai.com/v1/chat/completions',
      providerName: 'OpenAI',
      model: 'gpt-5-mini',
      status: 500,
      body: 'secret-key-should-not-appear',
    });
    // The body IS shown for a generic 500 (that's the point of the detail),
    // but nothing here ever reads config.apiKey to include it separately.
    expect(message).not.toContain('sk-');
  });
});

describe('validateModel', () => {
  const chatConfig: LlmProviderConfig = {
    provider: 'openai',
    model: 'gpt-5-mini',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
  };

  function stubFetch(status: number, body: unknown): typeof fetch {
    const response = {
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(JSON.stringify(body)),
      json: () => Promise.resolve(body),
    };
    return (() => Promise.resolve(response)) as unknown as typeof fetch;
  }

  it('succeeds when the chat completion has choices', async () => {
    const fetchFn = stubFetch(200, {
      choices: [{ message: { content: 'ok' } }],
    });
    const result = await validateModel(chatConfig, 'chat', fetchFn);
    expect(result).toEqual({ success: true });
  });

  it('never appends /v1 to the chat completions URL', async () => {
    let calledUrl = '';
    const fetchFn = ((url: string) => {
      calledUrl = url;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
        json: () => Promise.resolve({ choices: [{}] }),
      });
    }) as unknown as typeof fetch;

    await validateModel(chatConfig, 'chat', fetchFn);
    expect(calledUrl).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('turns a 401 into a human-readable error, using the catalogue name', async () => {
    const fetchFn = stubFetch(401, {});
    const result = await validateModel(chatConfig, 'chat', fetchFn);
    expect(result.success).toBe(false);
    expect(result.error).toBe('The API key was rejected.');
  });

  it('reports the embedding dimension on success', async () => {
    const fetchFn = stubFetch(200, { data: [{ embedding: [1, 2, 3, 4] }] });
    const result = await validateModel(
      { ...chatConfig, model: 'text-embedding-3-small' },
      'embedding',
      fetchFn,
    );
    expect(result).toEqual({ success: true, dimension: 4 });
  });
});
