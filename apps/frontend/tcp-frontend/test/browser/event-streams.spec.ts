// hosting.spec.ts proved the HTTP/2 transport for ordinary requests: the
// browser reports `h2`, and eight concurrent requests that resolve instantly
// open zero new connections. It could not prove the thing ADR-025 is actually
// about, because long-lived authenticated SSE connections did not exist yet —
// eight requests that return immediately prove nothing about concurrency. The
// failure this guards against is the *seventh stream hanging with no error*,
// which only shows up once a stream stays open.
//
// The Playwright tier still cannot sign in: `?devSession=` is compiled out of
// the production build it drives, and no browser test completes a Zitadel
// login. So this uses the same machine token the api tier uses
// (ApiHelper.getMachineToken), obtained directly against the OIDC provider
// with the client_credentials grant.
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';

const OIDC_DISCOVERY_URL =
  process.env.OIDC_DISCOVERY_URL ??
  'http://localhost:8080/.well-known/openid-configuration';
const TEST_CLIENT_ID = process.env.TEST_CLIENT_ID ?? '';
const TEST_CLIENT_SECRET = process.env.TEST_CLIENT_SECRET ?? '';
const hasCredentials = Boolean(TEST_CLIENT_ID && TEST_CLIENT_SECRET);

// The HTTP/1.1 ceiling this suite exists to prove the transport is past.
const STREAM_COUNT = 7;

interface TokenEndpoint {
  token_endpoint: string;
}

interface TokenResponse {
  access_token: string;
}

interface CreatedCompany {
  id: string;
}

/**
 * Obtains a machine (client_credentials) access token directly from the OIDC
 * provider — the same flow `ApiHelper.getMachineToken` uses for the api test
 * tier, since there is no browser sign-in journey this tier can drive yet.
 */
const getMachineToken = async (request: APIRequestContext): Promise<string> => {
  const discovery = await request.get(OIDC_DISCOVERY_URL);
  expect(discovery.ok()).toBe(true);
  const { token_endpoint } = (await discovery.json()) as TokenEndpoint;

  const tokenRes = await request.post(token_endpoint, {
    form: {
      grant_type: 'client_credentials',
      client_id: TEST_CLIENT_ID,
      client_secret: TEST_CLIENT_SECRET,
      scope: 'openid profile',
    },
  });
  expect(tokenRes.ok()).toBe(true);
  const { access_token } = (await tokenRes.json()) as TokenResponse;
  return access_token;
};

// Static, not fixture-dependent — so Playwright can skip every test in this
// file up front, without running beforeAll/afterAll (and without a machine
// token attempt) when the credentials simply aren't there. The other browser
// specs don't need them; a missing token here must not fail those.
test.skip(
  !hasCredentials,
  'TEST_CLIENT_ID/TEST_CLIENT_SECRET not set — pass --client-id/--client-secret ' +
    'or --env-file to run-browser-tests.sh',
);

test.describe('event streams', () => {
  let token: string;
  let companyId: string;

  test.beforeAll(async ({ request }) => {
    token = await getMachineToken(request);

    const created = await request.post('/api/company', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: 'event-streams browser test',
        slug: `event-streams-${Date.now().toString(36)}`,
        description: 'Created by event-streams.spec.ts',
      },
    });
    expect(created.status()).toBe(201);
    companyId = ((await created.json()) as CreatedCompany).id;
  });

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/company/${companyId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  });

  interface StreamProbeArgs {
    token: string;
    companyId: string;
    count: number;
  }

  /**
   * Opens `count` concurrent event-stream requests to the same company URL
   * and reports, per stream, whether a first chunk arrived before a 15s
   * per-stream timeout. All streams share one `AbortController`, so the
   * single `abort()` call after collection tears every one of them down.
   */
  const probeConcurrentStreams = (
    page: Page,
    args: StreamProbeArgs,
  ): Promise<boolean[]> =>
    page.evaluate<boolean[], StreamProbeArgs>(
      async ({ token: accessToken, companyId: id, count }) => {
        const controller = new AbortController();
        const url = `/api/company/${id}/events`;

        const probeOne = async (): Promise<boolean> => {
          try {
            const res = await fetch(url, {
              headers: { Authorization: `Bearer ${accessToken}` },
              signal: controller.signal,
            });
            const reader = res.body?.getReader();
            if (!reader) return false;

            // A 15s race, not an unbounded await: under HTTP/1.1 the
            // seventh stream hangs rather than erroring, so a plain await
            // here would just make the test itself hang.
            const timeout = new Promise<null>((resolve) => {
              setTimeout(() => resolve(null), 15_000);
            });
            const result = await Promise.race([reader.read(), timeout]);
            return result !== null && !result.done;
          } catch {
            return false;
          }
        };

        const results = await Promise.all(
          Array.from({ length: count }, () => probeOne()),
        );
        controller.abort();
        return results;
      },
      args,
    );

  test('seven concurrent event streams all deliver', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/');

    // Seven requests to the SAME company id — not seven different companies
    // — is the deliberate choice, not an oversight. The HTTP/1.1 cap is six
    // connections per *origin*, path-independent, so seven identical URLs
    // exercise it exactly as well as seven distinct ones. And the company
    // stream primes with current state on subscribe (ADR-025), so every one
    // of the seven delivers a chunk immediately if the transport allows it —
    // there's no need to manufacture seven companies just to get seven
    // streams that have something to send.
    const results = await probeConcurrentStreams(page, {
      token,
      companyId,
      count: STREAM_COUNT,
    });

    expect(results).toEqual(Array(STREAM_COUNT).fill(true));
  });

  interface SingleStreamArgs {
    token: string;
    companyId: string;
  }

  test('an event stream negotiates HTTP/2', async ({ page }) => {
    await page.goto('/');

    // Asserting the negotiated protocol, not just that a chunk arrived — a
    // regression to HTTP/1.1 here would otherwise surface as the previous
    // test timing out, which reads as "the stream never opened" rather than
    // naming the actual cause.
    const protocol = await page.evaluate<string | undefined, SingleStreamArgs>(
      async ({ token: accessToken, companyId: id }) => {
        performance.clearResourceTimings();
        const controller = new AbortController();
        const url = `/api/company/${id}/events`;

        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: controller.signal,
        });
        const reader = res.body?.getReader();
        const timeout = new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), 15_000);
        });
        await Promise.race([reader?.read(), timeout]);
        controller.abort();

        // A resource timing entry is only queued once its request settles —
        // aborting is what lets this one complete — so the same short poll
        // hosting.spec.ts uses guards against reading the buffer before the
        // entry lands.
        const collect = () =>
          performance
            .getEntriesByType('resource')
            .map((entry) => entry as PerformanceResourceTiming)
            .find((entry) => entry.name.endsWith(url));

        let entry = collect();
        for (let attempt = 0; attempt < 50 && !entry; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          entry = collect();
        }
        return entry?.nextHopProtocol;
      },
      { token, companyId },
    );

    expect(protocol).toBe('h2');
  });
});
