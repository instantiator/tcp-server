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

/** Every URL requested so far, in order — for asserting on query parameters. */
export const requestedUrls = (): string[] =>
  fetchMock.mock.calls.map(([input]) =>
    input instanceof Request ? input.url : String(input),
  );
