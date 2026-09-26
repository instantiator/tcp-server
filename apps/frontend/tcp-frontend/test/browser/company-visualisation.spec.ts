// The isometric office view (000.01), `CompanyPage`'s default tab. Roles and
// task rooms are real Phaser draws behind a canvas element, so this is the
// one tier that can prove the canvas actually renders — the component tier
// mocks Phaser entirely (see `TcpPhaserVisualisation.test.tsx`). Two credential
// sets are required and neither is optional: the human session to view the
// page, and the machine token to create what it shows, exactly as
// `company-activity.spec.ts` uses for its own fixtures. There is no shared
// helper module between browser specs (each is a self-contained black box,
// same as the api/smoke tiers), so `getMachineToken` below is a deliberate
// duplicate of that file's, not a shared import.
import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { AUTH_STATE_PATH, hasSignInCredentials } from './auth-state';

const OIDC_DISCOVERY_URL =
  process.env.OIDC_DISCOVERY_URL ??
  'http://localhost:8080/.well-known/openid-configuration';
const TEST_CLIENT_ID = process.env.TEST_CLIENT_ID ?? '';
const TEST_CLIENT_SECRET = process.env.TEST_CLIENT_SECRET ?? '';
const hasMachineCredentials = Boolean(TEST_CLIENT_ID && TEST_CLIENT_SECRET);

/*
 * Copied from `apps/frontend/tcp-frontend/src/strings.ts`
 * (`visualisation.stage.label`, `company.tab.visualisation` and
 * `visualisation.summary`). `strings.ts` is app source, not something a
 * browser spec can import, so these are literals — keep them in step by hand
 * if the copy there ever changes.
 */
const OFFICE_VIEW_LABEL = 'Office view';
const COMPANY_VIEW_TAB = 'Company view';

/** The visualisation's hidden summary, built the same way `t('visualisation.summary', …)` does. */
const summary = (roles: number, taskRooms: number, agents: number): string =>
  `Roles: ${roles}. Task rooms: ${taskRooms}. Agents: ${agents}.`;

interface TokenEndpoint {
  token_endpoint: string;
}

interface TokenResponse {
  access_token: string;
}

interface CreatedCompany {
  id: string;
}

interface CreatedRole {
  id: string;
}

interface CreatedTask {
  id: string;
}

/**
 * Obtains a machine (client_credentials) access token directly from the OIDC
 * provider — see `event-streams.spec.ts`, which this mirrors: there is no
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

/** The visualisation tab's hidden summary, by its accessible description. */
const officeSummary = (page: Page) =>
  page.getByRole('group', { name: OFFICE_VIEW_LABEL });

// Opting in, because the project default is signed out (007.03) — see
// `companies.spec.ts`.
test.use({
  storageState: hasSignInCredentials ? AUTH_STATE_PATH : undefined,
});

// Static, not fixture-dependent, so Playwright can skip every test in this
// file — including `beforeAll` — without attempting either credential when
// one is simply not there. Mirrors `event-streams.spec.ts`'s top-level skip.
test.skip(
  !hasSignInCredentials || !hasMachineCredentials,
  'Requires TEST_USERNAME/TEST_PASSWORD (the signed-in session) and ' +
    'TEST_CLIENT_ID/TEST_CLIENT_SECRET (the machine-token fixtures) — see ' +
    'scripts/run-browser-tests.sh.',
);

test.describe('company visualisation', () => {
  let token: string;
  let companyId: string;

  // Real fixtures, not seeded data (ADR-016's black-box posture applied to
  // this tier too): a test that needs a particular row to already exist fails
  // on a fresh deployment for a reason that has nothing to do with the code
  // under test.
  test.beforeAll(async ({ request }) => {
    token = await getMachineToken(request);
    const suffix = Date.now().toString(36);

    const company = await request.post('/api/company', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: `company-visualisation browser test ${suffix}`,
        slug: `company-visualisation-${suffix}`,
        description: 'Created by company-visualisation.spec.ts',
      },
    });
    expect(company.status()).toBe(201);
    companyId = ((await company.json()) as CreatedCompany).id;

    // Two roles, so the rec room's default summary reads "Roles: 2" rather
    // than the degenerate, easy-to-fake case of one.
    for (const roleSuffix of ['a', 'b']) {
      const role = await request.post('/api/role', {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          companyId,
          slug: `visualisation-role-${roleSuffix}-${suffix}`,
          name: `Visualisation role ${roleSuffix}`,
          description: 'Created by company-visualisation.spec.ts',
          knowledgeDomains: [],
          mcpServerList: [],
        },
      });
      expect(role.status()).toBe(201);
      // The response is only checked for shape here — nothing in this file
      // needs the role's id back.
      void ((await role.json()) as CreatedRole).id;
    }
  });

  test.afterAll(async ({ request }) => {
    // `TcpCompany` cascades its roles and tasks, so nothing else to clean up.
    await request.delete(`/api/company/${companyId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  });

  test('shows the office view by default, with no page errors', async ({
    page,
  }) => {
    const pageErrors: Error[] = [];
    // Attached before `goto`, so a load-time error cannot be missed.
    page.on('pageerror', (err) => {
      pageErrors.push(err);
    });

    await page.goto(`/company/${companyId}`);

    await expect(
      page.getByRole('tab', { name: COMPANY_VIEW_TAB }),
    ).toHaveAttribute('aria-selected', 'true');

    const office = officeSummary(page);
    await expect(office).toBeVisible();
    await expect(office).toHaveAccessibleDescription(summary(2, 0, 0));

    const canvas = office.locator('canvas');
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.width).toBeGreaterThan(0);
    expect(box?.height).toBeGreaterThan(0);

    expect(pageErrors).toEqual([]);
  });

  test('has no accessibility violations on the office view', async ({
    page,
  }) => {
    await page.goto(`/company/${companyId}`);

    await expect(officeSummary(page)).toHaveAccessibleDescription(
      summary(2, 0, 0),
    );

    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations).toEqual([]);
  });

  test('shows a task room, and removes it live when the task is cancelled', async ({
    page,
    request,
  }) => {
    // The task is created BEFORE the page opens. Creating a task publishes no
    // live event (000.01 unresolved notes), so an open page would only see a
    // new task once it is started. Removal is the live half tested here.
    const createdTask = await request.post('/api/task', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        companyId,
        request: 'Created by company-visualisation.spec.ts',
      },
    });
    expect(createdTask.status()).toBe(201);
    const taskId = ((await createdTask.json()) as CreatedTask).id;

    await page.goto(`/company/${companyId}`);

    const office = officeSummary(page);
    await expect(office).toHaveAccessibleDescription(summary(2, 1, 0));

    // Driving the change through the real API, not the cache: this is the
    // one test in this file proving the browser receives a live event over an
    // actual connection, the same reasoning `company-activity.spec.ts`'s
    // cancellation test gives for doing the same thing.
    const cancelled = await request.post(`/api/task/${taskId}/cancel`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(cancelled.status()).toBe(202);

    await expect(office).toHaveAccessibleDescription(summary(2, 0, 0));
  });
});
