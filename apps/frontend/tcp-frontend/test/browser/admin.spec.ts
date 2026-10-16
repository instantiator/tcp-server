import { expect, test, type APIRequestContext } from '@playwright/test';
import { AUTH_STATE_PATH, hasSignInCredentials } from './auth-state';
import { gotoSignedIn } from './signed-in';

const OIDC_DISCOVERY_URL =
  process.env.OIDC_DISCOVERY_URL ??
  'http://localhost:8080/.well-known/openid-configuration';
const TEST_CLIENT_ID = process.env.TEST_CLIENT_ID ?? '';
const TEST_CLIENT_SECRET = process.env.TEST_CLIENT_SECRET ?? '';
const hasMachineCredentials = Boolean(TEST_CLIENT_ID && TEST_CLIENT_SECRET);

interface TokenEndpoint {
  token_endpoint: string;
}
interface TokenResponse {
  access_token: string;
}

/** A machine token, as `company-activity.spec.ts` gets one, for fixtures. */
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

/*
 * Literals copied from `strings.ts`, as the other specs do, so a wording
 * change fails here rather than silently testing the wrong control.
 */
const ADD_ROLE = 'Add role';
const KNOWLEDGE_TAB = 'Knowledge';
const UPLOAD = 'Upload a document';
const SHARED_HEADING = 'Shared knowledge';
const DELETE_ONE = 'Delete 1 selected role';
const DELETE_CONFIRM = 'Delete';

/** One empty company, through the API only. */
interface Fixture {
  readonly token: string;
  readonly companyId: string;
}

const makeFixture = async (request: APIRequestContext): Promise<Fixture> => {
  const token = await getMachineToken(request);
  // `fullyParallel` runs every test at once; the random half keeps slugs apart.
  const slug = `admin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const company = await request.post('/api/company', {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: slug, slug, description: 'Created by admin.spec.ts' },
  });
  expect(company.status()).toBe(201);
  const { id: companyId } = (await company.json()) as { id: string };
  return { token, companyId };
};

/** Deleting the company cascades to its roles and knowledge. */
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

test.describe('company administration', () => {
  let fixture: Fixture;

  test.beforeEach(async ({ request }) => {
    fixture = await makeFixture(request);
  });

  test.afterEach(async ({ request }) => {
    await dropFixture(request, fixture);
  });

  test('a role is added, given a document, then deleted', async ({ page }) => {
    const name = `Tester ${Math.random().toString(36).slice(2, 8)}`;
    await gotoSignedIn(page, `/company/${fixture.companyId}#admin/roles`);
    await page.getByRole('button', { name: ADD_ROLE, exact: true }).click();

    const dialog = page.getByRole('dialog', { name: ADD_ROLE });
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
    await dialog
      .getByRole('textbox', { name: 'Description', exact: true })
      .fill('Made by admin.spec.ts');
    await dialog
      .getByRole('textbox', { name: 'Role prompt', exact: true })
      .fill('Do the testing.');
    await dialog.getByRole('button', { name: ADD_ROLE, exact: true }).click();

    // The dialog stays open on the new role, and its Knowledge tab unlocks.
    const saved = page.getByRole('dialog', { name });
    await expect(saved).toBeVisible();
    await saved.getByRole('tab', { name: KNOWLEDGE_TAB }).click();
    await saved.getByLabel(UPLOAD).setInputFiles({
      name: 'notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('---\ntitle: Notes\n---\n\nSome notes.'),
    });
    await expect(
      saved.getByRole('rowheader', { name: 'notes.md' }),
    ).toBeVisible();

    await saved.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(saved).toHaveCount(0);

    const row = page.getByRole('row', { name: new RegExp(name) });
    // The checkbox input sits under its styled label, which takes the click.
    await row.locator('label').first().click();
    await page.getByRole('button', { name: DELETE_ONE }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: DELETE_CONFIRM, exact: true })
      .click();
    await expect(row).toHaveCount(0);
  });

  test('the Knowledge section shows the company-wide documents', async ({
    page,
  }) => {
    await gotoSignedIn(page, `/company/${fixture.companyId}#admin/knowledge`);
    await expect(
      page.getByRole('heading', { name: SHARED_HEADING }),
    ).toBeVisible();
  });
});
