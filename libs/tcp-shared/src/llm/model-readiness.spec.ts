import type { LlmConfig } from '../models/LlmConfig.model';
import { checkModelReady } from './model-readiness';

const local: LlmConfig = {
  provider: 'lm-studio',
  model: 'google/gemma-4-e4b',
  baseUrl: 'http://host.docker.internal:1234/v1/',
  apiKey: 'sk-test',
};

/** A fetch that answers every request with `body` and `status`. */
const answering = (body: unknown, status = 200) =>
  jest.fn<Promise<Response>, Parameters<typeof fetch>>(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status })),
  );

describe('checkModelReady', () => {
  it('passes a listed model, asking with the key', async () => {
    const fetchFn = answering({ data: [{ id: 'google/gemma-4-e4b' }] });
    expect(await checkModelReady(local, fetchFn)).toBeNull();
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('http://host.docker.internal:1234/v1/models');
    expect(init?.headers).toEqual({ Authorization: 'Bearer sk-test' });
  });

  // LM Studio otherwise answers with whatever model is loaded.
  it('fails a model the server does not list', async () => {
    const failure = await checkModelReady(
      { ...local, model: 'no-such-model' },
      answering({ data: [{ id: 'google/gemma-4-e4b' }] }),
    );
    expect(failure?.code).toBe('model_not_found');
    expect(failure?.message).toContain("'no-such-model'");
  });

  it('fails a server that does not answer', async () => {
    const failure = await checkModelReady(local, () =>
      Promise.reject(new TypeError('fetch failed')),
    );
    expect(failure?.code).toBe('unreachable');
    expect(failure?.message).toContain('host.docker.internal:1234');
  });

  it.each([
    ['an error status', answering({}, 404)],
    ['a body that is not a model list', answering({ hello: 'world' })],
  ])('goes ahead on %s', async (_label, fetchFn) => {
    expect(await checkModelReady(local, fetchFn)).toBeNull();
  });

  it.each<[string, LlmConfig]>([
    [
      'a remote provider',
      {
        provider: 'openai',
        model: 'gpt-x',
        baseUrl: 'https://api.openai.com/v1',
      },
    ],
    ['a config with no base URL', { provider: 'lm-studio', model: 'm' }],
  ])('skips %s', async (_label, config) => {
    const fetchFn = answering({ data: [] });
    expect(await checkModelReady(config, fetchFn)).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
