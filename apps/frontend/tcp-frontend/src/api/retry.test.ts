import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { retryQuery } from './client';
import { ApiError } from './errors';

const failure = (status: number) => new ApiError(status, 'failed', undefined);

describe('retryQuery', () => {
  it.each([0, 429, 502, 503, 504])(
    'retries a %i three times, then stops',
    (status) => {
      expect([0, 1, 2, 3].map((n) => retryQuery(n, failure(status)))).toEqual([
        true,
        true,
        true,
        false,
      ]);
    },
  );

  it('retries a 500 once', () => {
    expect([0, 1].map((n) => retryQuery(n, failure(500)))).toEqual([
      true,
      false,
    ]);
  });

  it.each([400, 401, 403, 404, 409, 410, 422])('never retries a %i', (s) => {
    expect(retryQuery(0, failure(s))).toBe(false);
  });

  it('never retries an error that is not an ApiError', () => {
    expect(retryQuery(0, new TypeError('a bug'))).toBe(false);
  });
});

describe('a QueryClient with the app defaults', () => {
  let client: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new QueryClient({
      defaultOptions: { queries: { retry: retryQuery } },
    });
  });

  afterEach(() => {
    client.clear();
    vi.useRealTimers();
  });

  /** Fetches once per queued answer: an `ApiError` status, or data. */
  const run = (answers: readonly (number | string)[]) => {
    const queryFn = vi.fn((): Promise<string> => {
      const next = answers[queryFn.mock.calls.length - 1];
      return typeof next === 'number'
        ? Promise.reject(failure(next))
        : Promise.resolve(next ?? 'done');
    });
    const result = client.fetchQuery({ queryKey: ['q'], queryFn });
    // Settled either way, so a rejection isn't reported as unhandled first.
    const settled = result.then(
      (data) => ({ data }),
      (error: unknown) => ({ error }),
    );
    return { queryFn, settled };
  };

  it('settles a 404 straight away, without retrying', async () => {
    const { queryFn, settled } = run([404]);
    await vi.runAllTimersAsync();
    expect(await settled).toEqual({ error: failure(404) });
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it('asks a 503 four times in all, then fails', async () => {
    const { queryFn, settled } = run([503, 503, 503, 503]);
    await vi.runAllTimersAsync();
    expect(await settled).toEqual({ error: failure(503) });
    expect(queryFn).toHaveBeenCalledTimes(4);
  });

  it('resolves when a retried 503 then succeeds', async () => {
    const { queryFn, settled } = run([503, 'ok']);
    await vi.runAllTimersAsync();
    expect(await settled).toEqual({ data: 'ok' });
    expect(queryFn).toHaveBeenCalledTimes(2);
  });
});
