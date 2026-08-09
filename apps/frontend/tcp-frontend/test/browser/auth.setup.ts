// Signs in once, so every other spec starts with a session (007.03).
//
// **What is saved is the identity provider's session, not the application's.**
// `src/auth/user-manager.ts` keeps tokens in `InMemoryWebStorage`, and
// `user-manager.test.ts` asserts nothing reaches `localStorage` or
// `sessionStorage` — so there is no application session for `storageState` to
// capture, and seeding one is not possible by design.
//
// What `storageState` does capture is Zitadel's own cookie on Zitadel's
// origin. With it present, a spec that lands on a guarded route is redirected
// to the provider, recognised without a prompt, and sent back — and the
// application mints a fresh in-memory token from the code in that callback.
// Every spec therefore signs in for real, silently, and only this file ever
// sees the login form.
//
// `?devSession=` is not an alternative: it fakes a signed-in shell and mints
// no token, so every API call behind it returns 401 (ADR-024). It is also
// compiled out of the production build this tier drives, which
// `app-shell.spec.ts` asserts and which must stay true.
import { expect, test as setup } from '@playwright/test';
import { AUTH_STATE_PATH, TEST_PASSWORD, TEST_USERNAME } from './auth-state';

setup('sign in', async ({ page }) => {
  setup.skip(
    TEST_USERNAME === '' || TEST_PASSWORD === '',
    'No TEST_USERNAME/TEST_PASSWORD. scripts/run-browser-tests.sh reads them from the env file; specs needing a session skip themselves.',
  );

  // A guarded route, so the application performs its own redirect. Building an
  // authorize URL here instead would keep passing after the app's redirect
  // broke, which is one of the things this is meant to catch.
  await page.goto('/companies');

  // Two screens, both submitting through `#submit-button`. Waiting for the
  // password field rather than clicking straight through is what stops the
  // second click resubmitting the first screen.
  await page.locator('#loginName').fill(TEST_USERNAME);
  await page.locator('#submit-button').click();

  const password = page.locator('#password');
  await expect(password).toBeVisible();
  await password.fill(TEST_PASSWORD);
  await page.locator('#submit-button').click();

  // Signed in is a rendered page, not a URL: the callback route resolves its
  // own address before the token exists, so asserting on the address alone
  // would pass while the application was still deciding whether to let us in.
  await expect(
    page.getByRole('heading', { level: 1, name: 'Companies' }),
  ).toBeVisible();

  await page.context().storageState({ path: AUTH_STATE_PATH });
});
