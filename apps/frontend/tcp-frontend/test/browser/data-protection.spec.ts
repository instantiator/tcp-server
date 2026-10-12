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

/*
 * Literals copied from `strings.ts`, as the other specs do, so a wording
 * change fails here rather than silently testing the wrong control.
 */
const TAB = 'Data protection';
const SEARCH_FIELD = 'Name, email or other details';
const SEARCH = 'Search';
const RESULTS = 'Rows in customers matching the search';
const DOWNLOAD_ONE = 'Download 1 selected row';
const DELETE_ONE = 'Delete 1 selected row';
const DELETE_HEADING = 'Delete 1 row?';
const DELETE_CONFIRM = 'Delete rows';
const LIST = 'Do-not-store list';
const LIST_FIELD = 'Name, email or other details not to store';
const LIST_ADD = 'Add to the list';
const TABLES_TAB = 'Tables';
const ADD_ROW = 'Add a row to customers';
const ADD_ROW_SUBMIT = 'Add row';
const WARN_HEADING = 'Store something on the do-not-store list?';

interface TokenEndpoint {
  token_endpoint: string;
}
interface TokenResponse {
  access_token: string;
}

/** A machine token, as `records.spec.ts` gets one, for fixtures. */
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
  return ((await tokenRes.json()) as TokenResponse).access_token;
};

/** A company with a `customers` table holding Ann Lee and Dan Ito. */
interface Fixture {
  readonly token: string;
  readonly companyId: string;
  readonly slug: string;
}

const makeFixture = async (request: APIRequestContext): Promise<Fixture> => {
  const token = await getMachineToken(request);
  const headers = { Authorization: `Bearer ${token}` };
  const slug = `dp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const company = await request.post('/api/company', {
    headers,
    data: {
      name: slug,
      slug,
      description: 'Created by data-protection.spec.ts',
    },
  });
  expect(company.status()).toBe(201);
  const { id: companyId } = (await company.json()) as { id: string };
  const base = `/api/company/${companyId}/records`;
  const table = await request.post(`${base}/tables`, {
    headers,
    data: {
      name: 'customers',
      purpose: 'People who order.',
      schema: {
        type: 'object',
        properties: { email: { type: 'string' }, name: { type: 'string' } },
        required: ['email'],
      },
      primaryKey: ['email'],
    },
  });
  expect(table.status()).toBe(201);
  for (const data of [
    { email: 'ann@example.com', name: 'Ann Lee' },
    { email: 'dan@example.com', name: 'Dan Ito' },
  ]) {
    const added = await request.post(`${base}/tables/customers/rows`, {
      headers,
      data: { data },
    });
    expect(added.status()).toBe(201);
  }
  return { token, companyId, slug };
};

const dropFixture = async (request: APIRequestContext, fixture: Fixture) => {
  await request.delete(`/api/company/${fixture.companyId}`, {
    headers: { Authorization: `Bearer ${fixture.token}` },
  });
};

test.use({ storageState: hasSignInCredentials ? AUTH_STATE_PATH : undefined });

test.skip(
  !hasSignInCredentials || !hasMachineCredentials,
  'Requires TEST_USERNAME/TEST_PASSWORD (the signed-in session) and ' +
    'TEST_CLIENT_ID/TEST_CLIENT_SECRET (the machine-token fixtures) — see ' +
    'scripts/run-browser-tests.sh.',
);

test.describe('data protection', () => {
  let fixture: Fixture;

  test.beforeEach(async ({ request }) => {
    fixture = await makeFixture(request);
  });

  test.afterEach(async ({ request }) => {
    await dropFixture(request, fixture);
  });

  test('a person is found, their rows downloaded, then deleted after asking', async ({
    page,
  }) => {
    await gotoSignedIn(page, `/company/${fixture.companyId}#data-protection`);
    await expect(page.getByRole('tab', { name: TAB })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page
      .getByRole('textbox', { name: SEARCH_FIELD, exact: true })
      .fill('ann');
    await page.getByRole('button', { name: SEARCH, exact: true }).click();

    const results = page.getByRole('grid', { name: RESULTS });
    await expect(results).toBeVisible();
    await expect(results.getByRole('row', { name: /Dan Ito/ })).toHaveCount(0);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    await results
      .getByRole('row', { name: /Ann Lee/ })
      .getByRole('checkbox')
      .check();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: DOWNLOAD_ONE }).click();
    expect((await download).suggestedFilename()).toMatch(
      new RegExp(
        `^\\d{4}-\\d\\d-\\d\\d \\d\\d-\\d\\d-\\d\\d ${fixture.slug} customers\\.csv$`,
      ),
    );

    await page.getByRole('button', { name: DELETE_ONE }).click();
    const confirm = page.getByRole('alertdialog', { name: DELETE_HEADING });
    await confirm.getByRole('button', { name: DELETE_CONFIRM }).click();
    await expect(page.getByText('No rows match "ann".')).toBeVisible();
  });

  test('a person on the do-not-store list is not stored without asking', async ({
    page,
  }) => {
    await gotoSignedIn(page, `/company/${fixture.companyId}#data-protection`);
    await page.getByRole('textbox', { name: LIST_FIELD }).fill('Cara Diaz');
    await page.getByRole('button', { name: LIST_ADD }).click();
    await expect(
      page
        .getByRole('grid', { name: LIST })
        .getByRole('row', { name: /Cara Diaz/ }),
    ).toBeVisible();

    await page.getByRole('tab', { name: TABLES_TAB }).click();
    await page.getByRole('option', { name: /^customers/ }).click();
    await page.getByRole('button', { name: ADD_ROW }).click();
    const add = page.getByRole('dialog', { name: ADD_ROW });
    await add.getByRole('textbox', { name: 'email' }).fill('cara@example.com');
    await add.getByRole('textbox', { name: 'name' }).fill('Mrs cara diaz');
    await add.getByRole('button', { name: ADD_ROW_SUBMIT }).click();

    const warn = page.getByRole('alertdialog', { name: WARN_HEADING });
    await expect(warn).toContainText('name');
    await warn.getByRole('button', { name: 'No' }).click();
    // Still open, so the person can change what they typed.
    await expect(add).toBeVisible();
  });
});
