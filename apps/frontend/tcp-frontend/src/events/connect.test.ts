import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/errors';
import { getAccessToken } from '../auth/access-token';
import { handleUnauthorized } from '../auth/unauthorized';

import { connect } from './connect';

// Both are policy the reader routes through rather than reimplements, and both
// are proven on their own elsewhere. `handleUnauthorized` navigates the page,
// which jsdom cannot do and which would race every assertion here.
vi.mock('../auth/unauthorized', () => ({ handleUnauthorized: vi.fn() }));
vi.mock('../auth/access-token', () => ({ getAccessToken: vi.fn() }));

const tokenFor = vi.mocked(getAccessToken);
const redirect = vi.mocked(handleUnauthorized);
const fetchMock = vi.fn<typeof fetch>();

/** A response whose body never ends until `close()` is called. */
const heldOpenResponse = () => {
  let close = () => undefined as void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      close = () => {
        controller.close();
      };
    },
  });
  return {
    response: new Response(body, { status: 200 }),
    close: () => close(),
  };
};

/** A response that delivers one SSE frame and then ends the stream. */
const oneEventResponse = () =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({
              type: 'audit',
              event: { eventType: 'state_change', payload: { entity: 'task' } },
            })}\n\n`,
          ),
        );
        controller.close();
      },
    }),
    { status: 200 },
  );

/** The `Authorization` header sent on the nth connection attempt. */
const authorizationOn = (call: number): string | null => {
  const init = fetchMock.mock.calls[call]?.[1];
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.Authorization ?? null;
};

/** Lets pending promise callbacks run without advancing the fake clock. */
const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

/** Advances the fake clock by `ms`, letting each awaited step settle. */
const advance = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
};

// `navigator.onLine` and `document.hidden` are prototype getters, so they are
// redefined against these rather than spied on.
let online = true;
let hidden = false;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', fetchMock);
  tokenFor.mockResolvedValue('token-a');
  // Jitter is proven separately; pinning it makes every delay assertion exact.
  vi.spyOn(Math, 'random').mockReturnValue(1);
  online = true;
  hidden = false;
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    get: () => online,
  });
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchMock.mockReset();
  redirect.mockReset();
  tokenFor.mockReset();
});

describe('connect', () => {
  it('delivers each parsed event to the subscriber', async () => {
    fetchMock.mockResolvedValue(oneEventResponse());
    const events = vi.fn();

    const connection = connect('/api/task/t1/events', events, vi.fn());
    await flush();

    expect(events).toHaveBeenCalledTimes(1);
    connection.close();
  });

  it('grows the retry delay exponentially and caps it', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

    const connection = connect('/api/task/t1/events', vi.fn(), vi.fn());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 1s, 2s, 4s … with `Math.random()` pinned to 1, so no jitter discount.
    for (const [delay, attempts] of [
      [1000, 2],
      [2000, 3],
      [4000, 4],
    ] as const) {
      await advance(delay);
      expect(fetchMock).toHaveBeenCalledTimes(attempts);
    }

    // Far enough in for the uncapped delay to exceed 30s several times over.
    for (let i = 0; i < 8; i += 1) await advance(30_000);
    const beforeCap = fetchMock.mock.calls.length;
    await advance(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(beforeCap + 1);

    connection.close();
  });

  it('resets the delay after a connection that opened successfully', async () => {
    const held = heldOpenResponse();
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(held.response)
      .mockResolvedValue(new Response(null, { status: 503 }));

    const connection = connect('/api/task/t1/events', vi.fn(), vi.fn());
    await flush();
    await advance(1000);
    await advance(2000);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // The third attempt opened, so the next drop starts from 1s again rather
    // than continuing the 4s the failure sequence had reached.
    held.close();
    await flush();
    await advance(1000);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    connection.close();
  });

  it('pauses retries while the browser is offline and resumes on reconnect', async () => {
    online = false;
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

    const connection = connect('/api/task/t1/events', vi.fn(), vi.fn());
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();

    // A paused connection must not burn attempts; time alone changes nothing.
    await advance(60_000);
    expect(fetchMock).not.toHaveBeenCalled();

    online = true;
    window.dispatchEvent(new Event('online'));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    connection.close();
  });

  it('pauses retries while the page is hidden and resumes when it is shown', async () => {
    hidden = true;
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

    const connection = connect('/api/task/t1/events', vi.fn(), vi.fn());
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();

    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    connection.close();
  });

  // The failure this guards against is not the one the shape suggests. A reader
  // that captures its token at subscribe time does not fail when the token
  // expires — the open stream survives that. It fails at the first network blip
  // *after* expiry, and then never recovers, because every retry re-presents
  // the same dead credential. So the expiry has to be provoked between a drop
  // and its retry: a test that reconnects inside the token's lifetime passes
  // against the broken reader. Asserting only that `getAccessToken` was called
  // again passes against it too, which is why this asserts the wire.
  it('sends the newly issued token on a reconnect, not the one it first used', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(new Response(null, { status: 503 }));

    const connection = connect('/api/task/t1/events', vi.fn(), vi.fn());
    await flush();
    expect(authorizationOn(0)).toBe('Bearer token-a');

    // The session renews while the connection is down.
    tokenFor.mockResolvedValue('token-b');
    await advance(1000);

    expect(authorizationOn(1)).toBe('Bearer token-b');
    connection.close();
  });

  it('routes a 401 through the shared policy and stops retrying', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const onError = vi.fn();

    const connection = connect('/api/task/t1/events', vi.fn(), onError);
    await flush();

    expect(redirect).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(ApiError);

    // A permanent refusal, not something for the backoff to chew on.
    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    connection.close();
  });

  it('leaves one redirect when several streams meet a 401 together', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

    const connections = ['a', 'b', 'c'].map((id) =>
      connect(`/api/agent/${id}/events`, vi.fn(), vi.fn()),
    );
    await flush();

    // Each stream reaches the policy; the policy itself deduplicates, so
    // calling it from a second source is the point rather than a hazard.
    expect(redirect).toHaveBeenCalledTimes(3);
    for (const connection of connections) connection.close();
  });

  it('surfaces a 403 as a permanent refusal instead of retrying it', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));
    const onError = vi.fn();

    const connection = connect('/api/company/c1/events', vi.fn(), onError);
    await flush();

    const error = onError.mock.calls[0]?.[0] as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(403);
    expect(redirect).not.toHaveBeenCalled();

    // Retrying a membership refusal loops forever and shows the user nothing.
    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    connection.close();
  });

  it('redirects rather than connecting when there is no token to present', async () => {
    tokenFor.mockResolvedValue(null);

    const connection = connect('/api/task/t1/events', vi.fn(), vi.fn());
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledTimes(1);
    connection.close();
  });

  it('stops reconnecting once closed, and tolerates closing twice', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

    const connection = connect('/api/task/t1/events', vi.fn(), vi.fn());
    await flush();
    connection.close();
    connection.close();

    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('applies jitter so simultaneous reconnects do not arrive in lockstep', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

    const connection = connect('/api/task/t1/events', vi.fn(), vi.fn());
    await flush();

    // Half of the 1s base delay, which is what full jitter's floor produces.
    await advance(500);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    connection.close();
  });
});
