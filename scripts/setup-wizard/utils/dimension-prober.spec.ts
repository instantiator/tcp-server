import type { LlmProviderConfig } from '../types';
import { probeDimension } from './dimension-prober';

const config: LlmProviderConfig = {
  provider: 'openai',
  model: 'text-embedding-3-small',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
};

/** Builds a `fetch`-shaped stub that resolves with the given status/body. */
function stubFetch(
  status: number,
  body: unknown,
  text: string = JSON.stringify(body),
): typeof fetch {
  const response = {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(body),
  };
  return (() => Promise.resolve(response)) as unknown as typeof fetch;
}

describe('probeDimension', () => {
  it('returns the vector width from a successful embedding call', async () => {
    const fetchFn = stubFetch(200, {
      data: [{ embedding: [0.1, 0.2, 0.3] }],
    });
    const result = await probeDimension(config, fetchFn);
    expect(result).toEqual({ dimension: 3 });
  });

  it('never appends /v1 — the base URL already has it', async () => {
    let calledUrl = '';
    const fetchFn = ((url: string) => {
      calledUrl = url;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
        json: () => Promise.resolve({ data: [{ embedding: [1] }] }),
      });
    }) as unknown as typeof fetch;

    await probeDimension(config, fetchFn);
    expect(calledUrl).toBe('https://api.openai.com/v1/embeddings');
  });

  it('carries the status and body when the server responds with an error', async () => {
    const fetchFn = stubFetch(401, {}, 'Unauthorized');
    const result = await probeDimension(config, fetchFn);
    expect(result).toEqual({
      dimension: null,
      status: 401,
      body: 'Unauthorized',
    });
  });

  it('reports a malformed body without an embedding array', async () => {
    const fetchFn = stubFetch(200, { data: [{}] });
    const result = await probeDimension(config, fetchFn);
    expect(result.dimension).toBeNull();
    expect(result.body).toBeDefined();
  });

  it('carries the thrown error when the request itself fails', async () => {
    const networkError = new Error('fetch failed');
    const fetchFn = (() =>
      Promise.reject(networkError)) as unknown as typeof fetch;
    const result = await probeDimension(config, fetchFn);
    expect(result).toEqual({ dimension: null, error: networkError });
  });
});
