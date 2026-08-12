import createClient from 'openapi-fetch';

import { getAccessToken } from '../auth/access-token';
import { handleUnauthorized } from '../auth/unauthorized';

import { apiError, networkError } from './errors';
import type { paths } from './schema';

/**
 * The one HTTP client the browser uses to reach tcp-server.
 *
 * `baseUrl` is the page's own origin, not `/api`. Every tcp-server controller
 * declares its own `api/…` path and there is no global prefix, so the
 * generated paths already carry it — a `/api` base produces
 * `/api/api/company`. The application is served from the same origin as the
 * API through a proxy (ADR-029), so the origin is read from the document
 * rather than configured.
 *
 * It is read rather than left empty because openapi-fetch builds a `Request`,
 * and a `Request` outside a browser refuses a relative URL. An empty base
 * works in the browser and fails in every test.
 *
 * The typed request plumbing is `openapi-fetch`'s; the three things ADR-021
 * asks for — the token, the error shape, the 401 policy — are the middleware
 * below and {@link unwrap}. The event stream reader (005.02) does not go
 * through this client, but reaches the same two auth functions and throws the
 * same `ApiError`, so there is one policy rather than two.
 */
export const api = createClient<paths>({
  baseUrl: window.location.origin,
  // Deferred, not captured. `createClient` defaults this to `globalThis.fetch`
  // read at module load, and a bound copy cannot be intercepted by anything
  // installed afterwards — a test double, or instrumentation. The failure is
  // the quiet kind: a suite that stubs `fetch` keeps passing while every
  // request goes to a real server.
  fetch: (request) => fetch(request),
});

api.use({
  onRequest: async ({ request }) => {
    // Read at the moment of the request, never captured. A held token keeps
    // going out after the user has signed in again (ADR-024). `null` means
    // signed out or expired, and then the right move is to send no header at
    // all and let the 401 below reach the one policy — a dead token would get
    // the same 401 with more to explain.
    const token = await getAccessToken();
    if (token !== null) request.headers.set('Authorization', `Bearer ${token}`);
    return request;
  },
  onResponse: ({ response }) => {
    // Not awaited, and nothing is retried after it. `handleUnauthorized()` is
    // one full-page redirect, not a renewal that returns something to try
    // again with — this client holds no refresh token (ADR-024, amendment
    // (a)). It already collapses concurrent 401s into a single navigation, so
    // there is no debounce to add here.
    if (response.status === 401) void handleUnauthorized();
    return response;
  },
});

/**
 * Turns one of {@link api}'s `{ data, error }` results into the value, or
 * throws an `ApiError`.
 *
 * TanStack Query wants a promise that resolves to data or rejects; openapi-fetch
 * returns a discriminated union that never rejects on an HTTP error. This is
 * the join, and every hook goes through it so there is exactly one place where
 * a failed call becomes a thrown error.
 */
export const unwrap = async <T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> => {
  let result: { data?: T; error?: unknown; response: Response };
  try {
    result = await call;
  } catch (cause) {
    // The request never landed. openapi-fetch lets a `fetch` rejection through
    // untouched, and an unhandled TypeError in a query function is reported as
    // a bug in the caller rather than as the outage it is.
    throw networkError(cause);
  }

  const { data, error, response } = result;
  // `data === undefined` on an otherwise-successful response means a body this
  // caller cannot use — a 204, or a parse that produced nothing. Throwing is
  // deliberate: the alternative is returning `undefined` typed as `T`, which
  // moves the failure to whichever component reads a field off it.
  if (!response.ok || data === undefined) throw apiError(response, error);
  return data;
};

/**
 * Checks a `202 Accepted` call succeeded, without expecting a body.
 *
 * `POST /api/agent/{id}/message` answers `202` with no content at all — the
 * generated type is `content?: never` — so {@link unwrap} would see
 * `data === undefined` on a perfectly good response and throw on success.
 * This checks the response, not the body.
 */
export const expectAccepted = async (
  call: Promise<{ error?: unknown; response: Response }>,
): Promise<void> => {
  let result: { error?: unknown; response: Response };
  try {
    result = await call;
  } catch (cause) {
    // The request never landed — same reasoning as `unwrap`'s catch above.
    throw networkError(cause);
  }

  const { error, response } = result;
  if (!response.ok) throw apiError(response, error);
};

/**
 * Posts one file as `multipart/form-data`.
 *
 * **The one request that does not go through {@link api}, and why.**
 * `openapi-typescript` maps `format: binary` to `string`, so the generated
 * type for an upload body is `{ file: string }` — a `File` cannot be passed to
 * it without a cast, and this project does not cast at the boundary. Rather
 * than weaken the type or bend the generator for a single route, this reaches
 * the same three things `client.ts` exists to own: the token, the 401 policy,
 * and the `ApiError` shape. `src/events/connect.ts` already does exactly this
 * for the event stream, for the same kind of reason.
 *
 * The path is a plain string rather than a generated one, which is the cost of
 * the above — it is built by the single caller in `endpoints.ts` and goes
 * nowhere near a component.
 *
 * `Content-Type` is deliberately unset: the browser writes it, including the
 * multipart boundary, which cannot be guessed here.
 */
export const postFile = async (path: string, file: File): Promise<void> => {
  const body = new FormData();
  body.append('file', file);

  const token = await getAccessToken();
  const headers = new Headers();
  if (token !== null) headers.set('Authorization', `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(new URL(path, window.location.origin), {
      method: 'POST',
      headers,
      body,
    });
  } catch (cause) {
    throw networkError(cause);
  }

  if (response.status === 401) void handleUnauthorized();
  if (!response.ok) {
    // The body is read here rather than by `apiError`, which takes an
    // already-parsed one: reading a stream twice throws and hides the real
    // failure.
    const parsed: unknown = await response.json().catch(() => null);
    throw apiError(response, parsed);
  }
};
