import { vi } from 'vitest';

/**
 * The network boundary, for tests that render a component which fetches.
 *
 * Mock here rather than at the hook, the query cache or the router: those are
 * the things under test, and a test that replaces them proves the page renders
 * a value it was handed rather than that it asks for the right one. `src/api/
 * client.ts` builds its client with a **deferred** fetch (`(request) =>
 * fetch(request)`) precisely so a global stub installed afterwards is still
 * reached.
 *
 * Call {@link installFetchMock} in a `beforeEach`. Note it uses `mockReset`
 * rather than `mockClear`: queued `mockResolvedValueOnce` responses survive
 * `mockClear`, so one test's unconsumed response becomes the next test's first
 * answer — which fails as an assertion about the wrong request, several tests
 * away from the cause.
 */
export const fetchMock = vi.fn<typeof fetch>();

/** Stubs `globalThis.fetch` and clears anything a previous test queued. */
export const installFetchMock = (): void => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
};

/** Queues one JSON response. Calls are answered in the order they are queued. */
export const respondWithJson = (status: number, body: unknown): void => {
  fetchMock.mockResolvedValueOnce(
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
};

/** One route's answer: a status and a body, or a body at 200. */
export interface RouteResponse {
  readonly status?: number;
  readonly body: unknown;
}

/**
 * Answers by **URL** rather than by call order.
 *
 * `respondWithJson` queues responses in sequence, which is exactly right for a
 * surface that makes one request. It stops being right as soon as a view mounts
 * several queries at once: the order they reach `fetch` in is a consequence of
 * render order and of TanStack Query's internal scheduling, so a queue couples
 * every test to both. Reordering two components in a `div` would then fail a
 * test about something else entirely, with the responses silently swapped.
 *
 * Patterns are tested in the order given and the first match wins, so a
 * specific route may precede a general one. An unmatched URL rejects rather
 * than returning an empty body — a request nobody anticipated is a fact worth
 * surfacing, not one to answer with `[]`.
 */
export const respondByRoute = (
  routes: readonly (readonly [RegExp, RouteResponse])[],
): void => {
  fetchMock.mockImplementation((input) => {
    const url = input instanceof Request ? input.url : String(input);
    const match = routes.find(([pattern]) => pattern.test(url));

    if (match === undefined) {
      return Promise.reject(new Error(`No route in this test answers ${url}`));
    }

    const { status = 200, body } = match[1];
    return Promise.resolve(
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
};

/** Every URL requested so far, in order — for asserting on query parameters. */
export const requestedUrls = (): string[] =>
  fetchMock.mock.calls.map(([input]) =>
    input instanceof Request ? input.url : String(input),
  );
