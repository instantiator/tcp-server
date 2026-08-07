// What nginx has to get right (ADR-029), asserted against the real deployment
// rather than read back off the configuration file. Every check here exists
// because its failure mode is quiet: a served-but-wrong cache header, a deep
// link that only 404s on refresh, or an HTTP/1.1 connection that looks perfect
// until the sixth stream opens and the seventh hangs with no error.
import { expect, test, type Page } from '@playwright/test';

/**
 * One resource's timing, reduced to the two facts this suite cares about.
 *
 * `reusedConnection` comes from resource timing's rule that a request served
 * over an existing connection reports `connectStart === connectEnd`; a request
 * that had to open one reports a real interval.
 */
interface ProbeTiming {
  url: string;
  protocol: string;
  reusedConnection: boolean;
}

/**
 * Fetches `paths` concurrently from the page and returns their resource
 * timings, waiting until every one has been recorded.
 *
 * The waiting is not incidental. `await fetch(…)` resolves when the response
 * headers arrive, but a resource timing entry is only queued once the entry is
 * complete — so reading the buffer straight after the await finds nothing,
 * intermittently, which reads as "HTTP/2 is off" rather than "the test raced".
 */
const timeConcurrentFetches = (
  page: Page,
  paths: string[],
): Promise<ProbeTiming[]> =>
  page.evaluate(async (targets) => {
    performance.clearResourceTimings();
    await Promise.all(
      // Read each body, not just its headers: an entry for a response nobody
      // drained can stay incomplete indefinitely.
      targets.map((path) => fetch(path).then((response) => response.text())),
    );

    const collect = () =>
      performance
        .getEntriesByType('resource')
        .filter((entry) => targets.some((path) => entry.name.endsWith(path)))
        .map((entry) => {
          const timing = entry as PerformanceResourceTiming;
          return {
            url: timing.name,
            protocol: timing.nextHopProtocol,
            reusedConnection: timing.connectEnd === timing.connectStart,
          };
        });

    let timings = collect();
    for (
      let attempt = 0;
      attempt < 50 && timings.length < targets.length;
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      timings = collect();
    }
    return timings;
  }, paths);

test.describe('static hosting', () => {
  test('serves the app over HTTP/2, for assets and for the API alike', async ({
    page,
  }) => {
    await page.goto('/');

    // `h2` is the ALPN identifier the browser reports for a negotiated HTTP/2
    // connection. Asserting the protocol rather than the nginx directive is
    // the whole point: `http2 on;` in a config file that never loads, or a
    // certificate nginx rejected at startup, both leave a server that answers
    // happily over HTTP/1.1.
    const navigationProtocol = await page.evaluate(() => {
      const [entry] = performance.getEntriesByType('navigation');
      return (entry as PerformanceNavigationTiming | undefined)
        ?.nextHopProtocol;
    });
    expect(navigationProtocol).toBe('h2');

    // The API travels the same connection — it is the same origin, which is
    // why ADR-029 chose a proxy. Its streams are the ones that would hit the
    // six-connection ceiling, so it is the leg that matters most.
    const [api] = await timeConcurrentFetches(page, ['/api/company']);
    expect(api?.protocol).toBe('h2');
  });

  test('carries eight simultaneous requests over one connection', async ({
    page,
  }) => {
    await page.goto('/');

    // Eight, because six is the HTTP/1.1 ceiling. The query string defeats any
    // caching, and config.js is `no-store` anyway.
    const probes = await timeConcurrentFetches(
      page,
      Array.from({ length: 8 }, (_, i) => `/config.js?probe=${i}`),
    );

    expect(probes).toHaveLength(8);
    expect(probes.map((p) => p.protocol)).toEqual(Array(8).fill('h2'));

    // The assertion that actually distinguishes HTTP/2 from a fast HTTP/1.1
    // server: under HTTP/1.1 these eight would have opened up to six
    // connections and queued the rest. Multiplexed, they open none — the
    // navigation above already established the only one there is.
    //
    // This is the closest provable form of ADR-025's "more than six
    // simultaneous streams works". The end-to-end version needs long-lived
    // authenticated SSE connections, which arrive with the stream client in
    // 005.02; eight instant 401s would prove nothing about concurrency.
    expect(probes.filter((p) => !p.reusedConnection)).toEqual([]);
  });

  test('never caches config.js, and caches hashed assets forever', async ({
    page,
    request,
  }) => {
    const config = await request.get('/config.js');
    // A config.js held over from another environment points the app at the
    // wrong identity provider, and the sign-in failure that follows says
    // nothing about where it came from.
    expect(config.headers()['cache-control']).toBe('no-store');

    await page.goto('/');
    const bundleSrc = await page
      .locator('script[type="module"]')
      .first()
      .getAttribute('src');
    // Vite content-hashes everything it emits under assets/, so this only
    // holds for the built bundle the deployment serves — not for a dev-web
    // stack, where Vite serves unhashed source modules.
    expect(bundleSrc).toMatch(/^\/assets\/.+\.js$/);

    const bundle = await request.get(bundleSrc ?? '');
    expect(bundle.headers()['cache-control']).toContain('immutable');
  });

  test('serves the app shell for a deep link on a fresh page load', async ({
    page,
  }) => {
    // A full navigation, not in-app routing — the distinction is the entire
    // bug. React Router handles this path fine once loaded; it is only
    // arriving here cold, as a browser refresh does, that reaches nginx.
    //
    // The probe path is deliberately one no route guards. nginx has no
    // location block below `/` other than `/api/`, `/assets/` and
    // `/config.js`, so any multi-segment path exercises the fallback
    // identically — but since 004.03 a *guarded* one redirects to the identity
    // provider the moment the app boots, taking the document being asserted on
    // out of the browser before it can be read. That redirect is this suite's
    // subject elsewhere; here it is only in the way.
    const response = await page.goto('/deep-link-probe/nested');

    expect(response?.status()).toBe(200);
    expect(response?.headers()['content-type']).toContain('text/html');

    // What is asserted is that nginx served the app document — the mount point
    // is there and config.js ran on this path too — not that anything
    // particular rendered.
    await expect(page.locator('#root')).toBeAttached();
    expect(await page.evaluate(() => '__TCP_CONFIG__' in window)).toBe(true);
  });

  test('reaches tcp-server through /api on the same origin', async ({
    request,
  }) => {
    const response = await request.get('/api/company');

    // 401 is a successful proof of reach: it is tcp-server's auth guard
    // answering, which nginx could not have produced. The body matters as
    // much as the status — an nginx error page would be HTML.
    expect(response.status()).toBe(401);
    expect(await response.json()).toMatchObject({ statusCode: 401 });
  });

  test('exposes the generated runtime configuration to the page', async ({
    page,
  }) => {
    await page.goto('/');

    const config = await page.evaluate(
      () =>
        (
          window as unknown as {
            __TCP_CONFIG__?: {
              oidcIssuerUrl?: string;
              oidcClientId?: string;
              oidcLoadUserInfo?: boolean;
            };
          }
        ).__TCP_CONFIG__,
    );

    expect(config?.oidcIssuerUrl).toBeTruthy();
    expect(config?.oidcClientId).toBeTruthy();

    // Strictly `false`, not falsy. Nothing type-checks the heredoc in
    // 10-tcp-init.sh against RuntimeConfig — they are a shell script and a
    // TypeScript interface that happen to agree — and a quoted 'false' would
    // satisfy the interface, be truthy at the one place it is read, and turn
    // the default into its opposite.
    expect(config?.oidcLoadUserInfo).toBe(false);
  });
});
