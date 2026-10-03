// The first pages this tier has ever reached signed in (007.03).
//
// Deliberately thin: it proves the harness carries a session and that the two
// pages behind the gate are reachable and accessible. `001.01` (phase 05) owns the MVP
// journeys themselves.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { AUTH_STATE_PATH, hasSignInCredentials } from './auth-state';

const OIDC_DISCOVERY_URL =
  process.env.OIDC_DISCOVERY_URL ??
  'http://localhost:8080/.well-known/openid-configuration';
const TEST_CLIENT_ID = process.env.TEST_CLIENT_ID ?? '';
const TEST_CLIENT_SECRET = process.env.TEST_CLIENT_SECRET ?? '';
const hasMachineCredentials = Boolean(TEST_CLIENT_ID && TEST_CLIENT_SECRET);

/*
 * Literals copied from `strings.ts` by hand, the same way every other
 * browser spec does (`header.account.label`, `header.account.profile`,
 * `profile.subject.label`, `dialog.close`) — needed only by the card
 * navigation fixture below, to read the signed-in human user's own `sub`
 * off the profile dialog.
 */
const ACCOUNT_LABEL = 'Account';
const MY_PROFILE_LABEL = 'My profile';
const PROFILE_SUBJECT_LABEL = 'Account identifier';
const CLOSE_LABEL = 'Close';

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
 * provider — see `company-activity.spec.ts`, which this mirrors: there is no
 * browser sign-in journey this tier can drive for fixture setup, so the api
 * tier's own flow is used to create them instead.
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

// 005.01: each company on `/companies` is a card (`li.tcp-card`) with one
// link (the name) and a stretched `::after` on that link making the whole
// card clickable. A real fixture is needed to click a specific card rather
// than whatever already exists in the deployment, so this gets its own
// `describe` with the same machine-token fixture pattern
// `company-activity.spec.ts` and `company-visualisation.spec.ts` use.
test.describe('company card navigation', () => {
  let token: string;
  let companyId: string;
  let companyName: string;

  test.skip(
    !hasSignInCredentials || !hasMachineCredentials,
    'Requires TEST_USERNAME/TEST_PASSWORD (the signed-in session) and ' +
      'TEST_CLIENT_ID/TEST_CLIENT_SECRET (the machine-token fixture) — see ' +
      'scripts/run-browser-tests.sh.',
  );

  test.beforeAll(async ({ request }) => {
    token = await getMachineToken(request);
    // `fullyParallel` (playwright.config.ts) runs this hook once per test,
    // often in the same millisecond on different workers, so a timestamp
    // alone collides on the slug's unique constraint — see
    // `company-activity.spec.ts`'s own note on the same fixture shape.
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    companyName = `companies browser test ${suffix}`;
    const company = await request.post('/api/company', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: companyName,
        slug: `companies-${suffix}`,
        description: 'Created by companies.spec.ts',
      },
    });
    expect(company.status()).toBe(201);
    companyId = ((await company.json()) as CreatedCompany).id;
  });

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/company/${companyId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  });

  test('clicking a card off its name link still navigates to the company', async ({
    page,
    request,
  }) => {
    // `POST /api/company` makes the CALLER the company's member
    // (`CompanyDbService.create`'s `creatorIdentifier` is the caller's own
    // `sub`) — the machine client here, not the browser's signed-in human
    // session — and `/companies` only ever asks for "mine"
    // (`CompanyDbService.list` is membership-scoped). Left alone, this
    // fixture would be invisible to the human session, the same gap
    // `scripts/start-dev.sh`'s `add_test_user_membership` exists to close for
    // seeded companies. There is no `/api/me`, so the human's own `sub` is
    // read the same way `ProfileDialog.tsx` shows it: straight off the ID
    // token via the profile dialog's "Account identifier" field
    // (`profile.subject.label`).
    await page.goto('/companies');
    await page.getByRole('button', { name: ACCOUNT_LABEL }).click();
    await page.getByRole('menuitem', { name: MY_PROFILE_LABEL }).click();
    const identifierField = page.locator('.profile-dialog__field', {
      hasText: PROFILE_SUBJECT_LABEL,
    });
    const identifierText = await identifierField.textContent();
    const humanSub = identifierText?.slice(PROFILE_SUBJECT_LABEL.length).trim();
    expect(humanSub).toBeTruthy();
    await page.getByRole('button', { name: CLOSE_LABEL }).click();

    const membership = await request.post(`/api/company/${companyId}/users`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { identifier: humanSub, memberType: 'owner' },
    });
    expect(membership.status()).toBe(201);

    // A fresh navigation, not a reload: the companies list is cached by the
    // earlier `goto` above (as empty, before membership existed), and a full
    // navigation is what a signed-in user clicking "Companies" again would
    // do, not something this test invents to dodge the cache.
    await page.goto('/companies');
    const card = page.locator('li.tcp-card', { hasText: companyName });
    await expect(card).toBeVisible();

    // Anywhere but the name link itself: the stat line reads "0 active
    // agents" for a fresh company (`companies.count.activeAgents.other`).
    // `force: true` is the point, not a workaround — Playwright's own
    // actionability check reports exactly what `CompaniesPage.test.tsx`
    // can only assert the precondition for (jsdom renders no CSS): the
    // real `<a class="tcp-card__link">` intercepts the click here, because
    // its stretched `::after` covers the whole card. A real click at this
    // position is handled by the browser the same way; forcing it past
    // Playwright's interception check is what proves the overlay, not the
    // text, is what a pointer actually meets.
    await card.getByText(/active agent/).click({ force: true });
    await expect(page).toHaveURL(new RegExp(`/company/${companyId}$`));
  });
});
