// 000.02 (spend tracking), stage 7: the breadcrumb spend bars and the
// Notifications activity tab, against a real deployment. The component tier
// (`CompanyPage.test.tsx`, `SpendBar.test.tsx`, `NotificationsList.test.tsx`)
// already proves the logic and the accessible structure against mocked data;
// this file only proves the same elements render against a real company with
// no spend caps configured, the same way `companies.spec.ts` is a thin
// reachability check rather than a re-test of component behaviour.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { AUTH_STATE_PATH, hasSignInCredentials } from './auth-state';
import { gotoSignedIn } from './signed-in';

const OIDC_DISCOVERY_URL =
  process.env.OIDC_DISCOVERY_URL ??
  'http://localhost:8080/.well-known/openid-configuration';
const TEST_CLIENT_ID = process.env.TEST_CLIENT_ID ?? '';
const TEST_CLIENT_SECRET = process.env.TEST_CLIENT_SECRET ?? '';
const hasMachineCredentials = Boolean(TEST_CLIENT_ID && TEST_CLIENT_SECRET);

/** `spend.bar.label` — both breadcrumb crumbs' bar, copied from `strings.ts`. */
const SPEND_BAR_LABEL = 'Spend';
/** `notifications.heading` / `notifications.empty.heading`, same source. */
const NOTIFICATIONS_HEADING = 'Notifications';
const NO_NOTIFICATIONS_HEADING = 'No notifications';

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

// Opting in, because the project default is signed out (007.03) — see
// `companies.spec.ts`.
test.use({
  storageState: hasSignInCredentials ? AUTH_STATE_PATH : undefined,
});

test.skip(
  !hasSignInCredentials || !hasMachineCredentials,
  'Requires TEST_USERNAME/TEST_PASSWORD (the signed-in session) and ' +
    'TEST_CLIENT_ID/TEST_CLIENT_SECRET (the machine-token fixtures) — see ' +
    'scripts/run-browser-tests.sh.',
);

test.describe('spend tracking', () => {
  let token: string;
  let companyId: string;
  let companyName: string;

  test.beforeAll(async ({ request }) => {
    token = await getMachineToken(request);
    // `fullyParallel` runs this hook once per test, often in the same
    // millisecond on different workers — the random half keeps the slug
    // unique (see `company-activity.spec.ts`).
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    companyName = `spend browser test ${suffix}`;

    const company = await request.post('/api/company', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: companyName,
        slug: `spend-${suffix}`,
        description: 'Created by spend.spec.ts',
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

  test('shows a keyboard-focusable spend meter on each breadcrumb crumb', async ({
    page,
  }) => {
    await gotoSignedIn(page, `/company/${companyId}`);

    // Two crumbs — Companies and the company itself — each carry their own
    // bar (`CompanyPage.tsx`), so the real accessible structure is two
    // same-named meters, not one.
    const bars = page.getByRole('meter', { name: SPEND_BAR_LABEL });
    await expect(bars).toHaveCount(2);

    // 1.4.13: the trigger is reachable and operable by keyboard alone, not
    // only by hover — `SpendBar`'s `Focusable` wrapper around a plain `<div
    // role="meter">` (the real `<Meter>` is hidden under it; see this
    // component's own doc comment) is what this proves against a real
    // browser's tab order.
    await bars.first().focus();
    await expect(bars.first()).toBeFocused();
  });

  test('has no accessibility violations with the spend bars on screen', async ({
    page,
  }) => {
    await gotoSignedIn(page, `/company/${companyId}`);
    await expect(
      page.getByRole('meter', { name: SPEND_BAR_LABEL }),
    ).toHaveCount(2);

    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations).toEqual([]);
  });

  test('shows the empty state on a fresh company’s Notifications tab', async ({
    page,
  }) => {
    await gotoSignedIn(page, `/company/${companyId}#notifications`);

    const region = page.getByRole('region', { name: NOTIFICATIONS_HEADING });
    await expect(region).toBeVisible();
    await expect(
      region.getByRole('heading', { name: NO_NOTIFICATIONS_HEADING }),
    ).toBeVisible();
  });
});
