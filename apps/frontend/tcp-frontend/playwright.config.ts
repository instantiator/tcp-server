// The browser tier (ADR-028). Like the api and smoke tiers it is black-box: it
// drives a deployment someone else started and takes its base URL as input
// (ADR-016). scripts/run-browser-tests.sh is the launcher.
import { defineConfig, devices } from '@playwright/test';
// Only the flag: the state path is named by the specs that opt in, not here.
import { hasSignInCredentials } from './test/browser/auth-state';

// Set by scripts/run-browser-tests.sh from its --base-url. The fallback is the
// deployment's default EXPOSE_PORT_WEB, for running `playwright test` directly
// against a stack someone already started.
//
// https, not http: the web service is TLS-only because HTTP/2 is (ADR-025), and
// no browser negotiates HTTP/2 over cleartext.
const baseURL = process.env.TCP_WEB_URL ?? 'https://localhost:5173';

export default defineConfig({
  testDir: './test/browser',
  // Traces and failure screenshots join the other tiers' artefacts under the
  // repo-root test-results/, which CI already uploads and .gitignore covers.
  outputDir: '../../../test-results/browser-artifacts',
  // A journey that needs its predecessor to have run is a journey that can't be
  // debugged in isolation, so they run in parallel and must stay independent.
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // No retries, deliberately. A retried test reports green while staying
  // unreliable, and a browser suite nobody trusts is one nobody reads — so an
  // intermittent failure has to be fixed rather than absorbed here.
  retries: 0,
  reporter: [
    ['list'],
    // The same JUnit XML the five Jest tiers emit, so CI reporting is uniform.
    ['junit', { outputFile: '../../../test-results/browser.xml' }],
  ],
  use: {
    baseURL,
    // The web container generates a self-signed certificate when none is
    // mounted, which is the default and is what CI runs against. Trusting it
    // here is not a lowered bar — mkcert is documented for humans who want the
    // browser to stop warning (docs/web-client.md), and the tier asserts on the
    // negotiated protocol either way.
    ignoreHTTPSErrors: true,
    // With no retries, a failure has to be diagnosable from its first and only
    // run — so the trace is kept then, not on a second attempt that never comes.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // Signs in once and saves the provider's session (007.03). Skips itself
    // when no credentials resolve, and the specs that need a session skip too
    // — a contributor with no deployment can still run the tier.
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      // The project stays **signed out**. A spec that wants the session opts
      // in with `test.use({ storageState: AUTH_STATE_PATH })`.
      //
      // The other way round is tempting and wrong: `app-shell.spec.ts` proves
      // that a guarded route redirects to the provider and that `?devSession=`
      // cannot sign anyone in against a production build. Both of those pass
      // trivially, and mean nothing, once the browser arrives already signed
      // in — and neither would fail to tell you so.
      dependencies: hasSignInCredentials ? ['setup'] : [],
    },
    // ponytail: one browser, one binary to install and cache. ADR-026's manual
    // matrix covers Safari and Firefox per release; 001.01 (phase 05) turns these on if
    // six real journeys justify the CI minutes.
    // { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    // { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  // No webServer block, deliberately. The deployment's tcp-web service serves
  // the app now, so this tier provisions nothing and drives whatever answers on
  // baseURL — the same black-box posture as the api and smoke tiers (ADR-016).
  // A fallback that started its own server would also serve HTTP/1.1, quietly
  // hiding the protocol regression this tier exists to catch.
});
