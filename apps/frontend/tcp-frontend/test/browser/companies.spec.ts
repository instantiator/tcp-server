// The first pages this tier has ever reached signed in (007.03).
//
// Deliberately thin: it proves the harness carries a session and that the two
// pages behind the gate are reachable and accessible. `009.01` owns the MVP
// journeys themselves.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { AUTH_STATE_PATH, hasSignInCredentials } from './auth-state';

// Opting in, because the project default is signed out — `app-shell.spec.ts`
// proves a guarded route redirects to the provider, and that passes trivially
// and silently once the browser arrives already signed in.
test.use({
  storageState: hasSignInCredentials ? AUTH_STATE_PATH : undefined,
});

test.describe('signed in', () => {
  test.skip(
    !hasSignInCredentials,
    'No TEST_USERNAME/TEST_PASSWORD — see scripts/run-browser-tests.sh.',
  );

  test('reaches the companies overview', async ({ page }) => {
    await page.goto('/companies');

    // By role and accessible name (ADR-028). Arriving here at all is the
    // assertion that matters: it means the guarded route redirected, the
    // provider recognised the saved session, the callback exchanged its code,
    // and a token was minted into memory — none of which this tier could do
    // before.
    await expect(
      page.getByRole('heading', { level: 1, name: 'Companies' }),
    ).toBeVisible();
  });

  test('has no accessibility violations on the companies overview', async ({
    page,
  }) => {
    await page.goto('/companies');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Companies' }),
    ).toBeVisible();

    // ADR-026 wants axe in both tiers. Until this harness existed the browser
    // tier could only scan the three pages a signed-out visitor can see.
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations).toEqual([]);
  });
});
