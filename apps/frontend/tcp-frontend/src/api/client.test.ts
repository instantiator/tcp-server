import { User } from 'oidc-client-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleUnauthorized } from '../auth/unauthorized';
import { getUserManager } from '../auth/user-manager';

import { api, unwrap } from './client';
import { ApiError } from './errors';

// The real policy navigates the page, which jsdom cannot do and which would
// make every assertion below race a redirect. Its deduplication is already
// proven in `../auth/unauthorized.test.ts`; what these tests are about is
// whether the wrapper reaches it at all.
vi.mock('../auth/unauthorized', () => ({ handleUnauthorized: vi.fn() }));

window.__TCP_CONFIG__ = {
  oidcIssuerUrl: 'https://idp.example.com',
  oidcClientId: 'test-web-client',
};

const profile = {
  sub: 'someone',
  iss: 'https://idp.example.com',
  aud: 'test-web-client',
  exp: 0,
  iat: 0,
};

/** A stored user holding `access_token`, valid unless `expires_at` says not. */
const storeUser = (access_token: string, expires_at?: number) =>
  getUserManager().storeUser(
    new User({ access_token, token_type: 'Bearer', profile, expires_at }),
  );

/** An epoch-seconds instant a minute in the past. */
const aMinuteAgo = () => Math.floor(Date.now() / 1000) - 60;

const fetchMock = vi.fn<typeof fetch>();

/** Answers the next request with `status` and `body`. */
const respondWith = (status: number, body: unknown, statusText = '') => {
  fetchMock.mockResolvedValueOnce(
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      statusText,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
};

/** The `Authorization` header on the nth request the client made. */
const authorizationOn = (call: number): string | null => {
  const request = fetchMock.mock.calls[call]?.[0];
  if (!(request instanceof Request)) throw new Error('no request was made');
  return request.headers.get('Authorization');
};

/** One arbitrary call through the client, so the middleware runs. */
const callApi = () => unwrap(api.GET('/api/company', {}));

/**
 * The {@link ApiError} a call failed with.
 *
 * `rejects.toMatchObject` cannot see `message`: it is a non-enumerable own
 * property of `Error`, so an assertion on it silently passes whatever the
 * message actually is.
 */
const failureFrom = async (call: Promise<unknown>): Promise<ApiError> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected the call to fail, and it succeeded');
};

describe('the API client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    await getUserManager().removeUser();
    vi.unstubAllGlobals();
    // `mockReset`, not `mockClear`: a queued `mockResolvedValueOnce` that a
    // failing test never consumed survives a clear and answers the next test's
    // first request instead.
    fetchMock.mockReset();
    vi.clearAllMocks();
  });

  describe('the bearer token', () => {
    it('attaches the signed-in user’s token', async () => {
      await storeUser('A-TOKEN');
      respondWith(200, []);

      await callApi();

      expect(authorizationOn(0)).toBe('Bearer A-TOKEN');
    });

    it('reads a fresh token per call rather than one it captured', async () => {
      // The failure this catches is silent until the first renewal: a wrapper
      // that read the token once — at module scope, or into a closure — keeps
      // presenting the old one and every request 401s for no visible reason.
      // A test that only asserts *a* token went out passes right through it.
      await storeUser('FIRST-TOKEN');
      respondWith(200, []);
      await callApi();

      await storeUser('SECOND-TOKEN');
      respondWith(200, []);
      await callApi();

      expect(authorizationOn(0)).toBe('Bearer FIRST-TOKEN');
      expect(authorizationOn(1)).toBe('Bearer SECOND-TOKEN');
    });

    it('sends no header at all when nobody is signed in', async () => {
      // Not an empty header, and not the string "Bearer null" — tcp-server
      // would reject both with a 401 that says nothing about the cause.
      respondWith(200, []);

      await callApi();

      expect(authorizationOn(0)).toBeNull();
    });
  });

  describe('the 401 policy', () => {
    it('routes a rejected token to the shared policy, once', async () => {
      await storeUser('DEAD-TOKEN');
      respondWith(401, { statusCode: 401, message: 'Unauthorized' });

      await expect(callApi()).rejects.toBeInstanceOf(ApiError);

      expect(handleUnauthorized).toHaveBeenCalledTimes(1);
    });

    it('still rejects the call rather than leaving it pending', async () => {
      // The page is navigating away, but the query has to settle: a promise
      // that never resolves leaves a component spinning behind the redirect,
      // and leaves the failure invisible if the navigation does not happen.
      await storeUser('DEAD-TOKEN');
      respondWith(401, { statusCode: 401, message: 'Unauthorized' });

      const error = await failureFrom(callApi());

      expect(error.status).toBe(401);
    });

    it('recovers a request made after the token expired', async () => {
      // Carried forward from 004.03, which was asked for this test and had no
      // wrapper to make the request with. Both halves were proven separately
      // there — `getAccessToken()` returns null past expiry, and
      // `handleUnauthorized()` makes exactly one redirect. This is the join:
      // the in-flight request that is refused, and the next one after it,
      // both reaching the shared policy rather than failing silently.
      await storeUser('EXPIRED-TOKEN', aMinuteAgo());

      respondWith(401, { statusCode: 401, message: 'Unauthorized' });
      await expect(callApi()).rejects.toBeInstanceOf(ApiError);

      respondWith(401, { statusCode: 401, message: 'Unauthorized' });
      await expect(callApi()).rejects.toBeInstanceOf(ApiError);

      // No dead token was presented on either attempt...
      expect(authorizationOn(0)).toBeNull();
      expect(authorizationOn(1)).toBeNull();
      // ...and neither request was dropped on the floor. Collapsing these two
      // into one navigation is the policy's job, and its own test's.
      expect(handleUnauthorized).toHaveBeenCalledTimes(2);
    });
  });

  describe('the error shape', () => {
    it.each([
      [400, 'Validation failed'],
      [401, 'Unauthorized'],
      [403, 'Forbidden resource'],
      [404, 'Company not found'],
      [409, 'A company with that slug already exists'],
      [500, 'Internal server error'],
    ])(
      'turns a %i into an ApiError carrying its message',
      async (status, message) => {
        respondWith(status, { statusCode: status, message });

        const error = await failureFrom(callApi());

        expect(error.status).toBe(status);
        expect(error.message).toBe(message);
        expect(error.body).toEqual({ statusCode: status, message });
      },
    );

    it('joins the several messages a rejected body comes back with', async () => {
      // ValidationPipe returns `message` as an array, one entry per failed
      // constraint. A caller that only handles the string renders
      // "[object Object]" on exactly the errors a user hits most.
      respondWith(400, {
        statusCode: 400,
        message: ['name should not be empty', 'slug must be a string'],
      });

      const error = await failureFrom(callApi());

      expect(error.message).toBe(
        'name should not be empty; slug must be a string',
      );
    });

    it('falls back to the status line when there is no message', async () => {
      respondWith(502, null, 'Bad Gateway');

      const error = await failureFrom(callApi());

      expect(error.message).toBe('Bad Gateway');
    });

    it('reports a request that never landed as status 0', async () => {
      // A refused connection rejects `fetch` outright. Left alone it surfaces
      // as an unhandled TypeError, which reads as a bug in the caller rather
      // than as the outage it is.
      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

      const error = await failureFrom(callApi());

      expect(error.status).toBe(0);
      expect(error.message).toBe('Failed to fetch');
    });

    it('does not call the 401 policy for any other failure', async () => {
      respondWith(403, { statusCode: 403, message: 'Forbidden resource' });

      await expect(callApi()).rejects.toBeInstanceOf(ApiError);

      expect(handleUnauthorized).not.toHaveBeenCalled();
    });
  });

  it('calls the API on its own origin, with no /api/api prefix', async () => {
    // `baseUrl` is empty because the generated paths already carry `/api`
    // (ADR-029). Setting it to '/api' looks more correct and produces
    // /api/api/company, which 404s in a way that reads as a routing fault.
    respondWith(200, []);

    await callApi();

    const request = fetchMock.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    expect(new URL((request as Request).url).pathname).toBe('/api/company');
  });
});
