// Opening a page as the signed-in test user, with sign-in timed apart from
// the test's own assertions.
import { expect, test, type Page } from '@playwright/test';

/**
 * How long a page may take to finish signing in. Generous on purpose: the app
 * keeps its token in memory (ADR-024), and the saved session holds only the
 * identity provider's cookie, so every `goto` starts signed out and runs a
 * full redirect and token exchange. Under `fullyParallel` load that took over
 * 4 s — most of the 5 s an assertion gets by default — and was the likely
 * cause of the office view flake (docs/outstanding-issues.md).
 */
const SIGN_IN_TIMEOUT_MS = 15_000;

/**
 * Opens `path` and waits until sign-in has finished, so the test's own
 * assertions time the page, not the identity provider. The header's Account
 * button is the signal: it renders only for a signed-in user.
 *
 * Records how long that took as a `sign-in` annotation and a `[sign-in]`
 * stdout line (which lands in the JUnit report), so slow sign-ins can be
 * checked later if a flake recurs.
 */
export async function gotoSignedIn(page: Page, path: string): Promise<void> {
  const started = Date.now();
  await page.goto(path);
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible({
    timeout: SIGN_IN_TIMEOUT_MS,
  });
  const elapsed = Date.now() - started;
  test.info().annotations.push({
    type: 'sign-in',
    description: `${path}: ${elapsed} ms`,
  });
  console.log(`[sign-in] ${path} ${elapsed} ms`);
}
