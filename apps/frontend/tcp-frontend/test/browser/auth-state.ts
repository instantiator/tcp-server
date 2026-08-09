// Where the signed-in session lives, and the credentials that create it.
//
// Its own module because `playwright.config.ts` needs the path too, and a
// config importing a spec file to get a constant is the kind of cycle that
// only shows up as a confusing Playwright error.
import { join } from 'node:path';

/**
 * The saved identity-provider session.
 *
 * Under the repo-root `test-results/`, which CI already collects and
 * `.gitignore` already covers — this file holds a real session cookie and must
 * never be committed.
 */
export const AUTH_STATE_PATH = join(
  import.meta.dirname,
  '../../../../../test-results/browser-auth-state.json',
);

/**
 * The human test user `start-deployment.sh` provisions.
 *
 * `scripts/run-browser-tests.sh` exports these from the env file, and only
 * when it resolves them — so an absent value means "no deployment
 * credentials", which specs turn into a skip rather than a failure.
 */
export const TEST_USERNAME = process.env.TEST_USERNAME ?? '';
export const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';

/** Whether a signed-in session is available to this run. */
export const hasSignInCredentials =
  TEST_USERNAME !== '' && TEST_PASSWORD !== '';
