// The browser tier (ADR-028). Like the api and smoke tiers it is black-box: it
// drives a deployment someone else started and takes its base URL as input
// (ADR-016). scripts/run-browser-tests.sh is the launcher.
import { defineConfig, devices } from '@playwright/test';

// Set by scripts/run-browser-tests.sh from its --base-url. The fallback is
// `vite preview`'s default port, for running `playwright test` directly during
// development. From 002.03 it becomes the deployment's EXPOSE_PORT_WEB.
const baseURL = process.env.TCP_WEB_URL ?? 'http://localhost:4173';

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
    // With no retries, a failure has to be diagnosable from its first and only
    // run — so the trace is kept then, not on a second attempt that never comes.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // ponytail: one browser, one binary to install and cache. ADR-026's manual
    // matrix covers Safari and Firefox per release; 009.01 turns these on if
    // six real journeys justify the CI minutes.
    // { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    // { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  // ponytail: temporary. Nothing serves the SPA until 002.03 puts it behind
  // nginx in the deployment — until then this starts `vite preview` so the tier
  // has something to drive. reuseExistingServer makes it inert the moment a
  // deployment answers on baseURL; delete the whole block in 002.03.
  webServer: {
    command: 'npm run preview',
    url: baseURL,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
