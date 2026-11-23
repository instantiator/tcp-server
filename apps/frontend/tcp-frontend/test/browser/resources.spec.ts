import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
} from '@playwright/test';
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
const SHOW_DETAILS_LABEL = 'Show details for';
const FOLLOW_LABEL = 'Follow';
const FULLSCREEN_LABEL = 'Full screen';
const RESOURCES_PICKER_LABEL = 'Resources';
const TRAY_HEADING = 'Company resources';
const BROWSE_ALL = 'Browse all resources';
const CHEST_TITLE = 'Plan chest';
const CHEST_DESCRIPTION = 'Company resources: documents the company keeps.';
const PRICING_ROW = 'pricing, Price lists';
const POLICIES_ROW = 'policies, Policies we follow';

/**
 * How far above its tile centre the chest's hit zone sits:
 * `FURNITURE_SIZES.resourcesChest.height / 2` (16 / 2) in `drawFurniture.ts`.
 */
const CHEST_ZONE_LIFT = 8;

interface TokenEndpoint {
  token_endpoint: string;
}
interface TokenResponse {
  access_token: string;
}

/** A machine token, as `storage-browser.spec.ts` gets one, for fixtures. */
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

/** A company with two resource folders, made through the API only. */
interface Fixture {
  readonly token: string;
  readonly companyId: string;
}

/** Stores a Markdown file straight through the storage route. */
const putFile = async (
  request: APIRequestContext,
  fixture: Fixture,
  path: string,
  text: string,
) => {
  const res = await request.post(
    `/api/company/${fixture.companyId}/storage/file?${new URLSearchParams({ path })}`,
    {
      headers: { Authorization: `Bearer ${fixture.token}` },
      multipart: {
        file: {
          name: path.split('/').pop() ?? path,
          mimeType: 'text/markdown',
          buffer: Buffer.from(text),
        },
      },
    },
  );
  expect(res.status()).toBe(201);
};

const makeFixture = async (request: APIRequestContext): Promise<Fixture> => {
  const token = await getMachineToken(request);
  // `fullyParallel` runs every test at once; the random half keeps slugs apart.
  const slug = `resources-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const company = await request.post('/api/company', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      name: slug,
      slug,
      description: 'Created by resources.spec.ts',
    },
  });
  expect(company.status()).toBe(201);
  const { id: companyId } = (await company.json()) as { id: string };
  const fixture = { token, companyId };
  // A file at the top of `resources/`, which only "Browse all" can reach.
  await putFile(request, fixture, 'resources/README.md', '# Company resources');
  await putFile(
    request,
    fixture,
    'resources/pricing/README.md',
    'Price lists\n\nWhat we charge.',
  );
  await putFile(
    request,
    fixture,
    'resources/policies/README.md',
    'Policies we follow\n\nHow we work.',
  );
  return fixture;
};

/** Deleting the company cascades to its stored files. */
const dropFixture = async (request: APIRequestContext, fixture: Fixture) => {
  await request.delete(`/api/company/${fixture.companyId}`, {
    headers: { Authorization: `Bearer ${fixture.token}` },
  });
};

/** True when `locator`'s element sits inside the page's full-screen element. */
const isInFullscreen = (locator: Locator) =>
  locator.evaluate((el) => document.fullscreenElement?.contains(el) ?? false);

test.use({ storageState: hasSignInCredentials ? AUTH_STATE_PATH : undefined });

test.skip(
  !hasSignInCredentials || !hasMachineCredentials,
  'Requires TEST_USERNAME/TEST_PASSWORD (the signed-in session) and ' +
    'TEST_CLIENT_ID/TEST_CLIENT_SECRET (the machine-token fixtures) — see ' +
    'scripts/run-browser-tests.sh.',
);

test.describe('company resources tray', () => {
  let fixture: Fixture;

  test.beforeEach(async ({ request }) => {
    fixture = await makeFixture(request);
  });

  test.afterEach(async ({ request }) => {
    await dropFixture(request, fixture);
  });

  test('the plan chest opens a tray of folders, from the keyboard, the picker and the office', async ({
    page,
  }) => {
    await gotoSignedIn(page, `/company/${fixture.companyId}`);
    const canvas = page
      .getByRole('group', { name: 'Office view' })
      .locator('canvas');

    await page.getByRole('button', { name: SHOW_DETAILS_LABEL }).click();
    await page
      .getByRole('option', { name: RESOURCES_PICKER_LABEL, exact: true })
      .click();
    const tray = page.getByRole('complementary', { name: TRAY_HEADING });
    await expect(tray).toBeVisible();
    const tree = tray.getByRole('treegrid', { name: TRAY_HEADING });
    const pricing = tree.getByRole('row', { name: PRICING_ROW });
    await expect(pricing).toBeVisible();
    await expect(tree.getByRole('row', { name: POLICIES_ROW })).toBeVisible();
    expect(
      (await new AxeBuilder({ page }).include('aside').analyze()).violations,
    ).toEqual([]);

    // Keyboard only: focus the tree, move to "pricing", open it, close it.
    await pricing.focus();
    await expect(pricing).toBeFocused();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'pricing' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Price lists');
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(pricing).toBeFocused();

    // Follow centres the camera on the chest, so the canvas's centre, lifted
    // onto its hit zone, is where the pointer meets it.
    await page.getByRole('button', { name: FOLLOW_LABEL, exact: true }).click();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2 - CHEST_ZONE_LIFT;
    await page.mouse.move(cx, cy);
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toContainText(CHEST_TITLE);
    await expect(tooltip).toContainText(CHEST_DESCRIPTION);
  });

  test('"Browse all resources" opens the whole folder, README included', async ({
    page,
  }) => {
    await gotoSignedIn(page, `/company/${fixture.companyId}`);
    await page.getByRole('button', { name: SHOW_DETAILS_LABEL }).click();
    await page
      .getByRole('option', { name: RESOURCES_PICKER_LABEL, exact: true })
      .click();
    const tray = page.getByRole('complementary', { name: TRAY_HEADING });
    await tray.getByRole('button', { name: BROWSE_ALL }).click();
    const dialog = page.getByRole('dialog', { name: TRAY_HEADING });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('row', { name: /README\.md/ })).toBeVisible();
  });

  test('the tray and its dialog stay inside the office in full screen', async ({
    page,
  }) => {
    await gotoSignedIn(page, `/company/${fixture.companyId}`);
    await page.getByRole('button', { name: SHOW_DETAILS_LABEL }).click();
    await page
      .getByRole('option', { name: RESOURCES_PICKER_LABEL, exact: true })
      .click();
    const tray = page.getByRole('complementary', { name: TRAY_HEADING });
    await expect(tray).toBeVisible();

    await page.getByRole('button', { name: FULLSCREEN_LABEL }).click();
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement !== null))
      .toBe(true);
    expect(await isInFullscreen(tray)).toBe(true);

    const pricing = tray
      .getByRole('treegrid', { name: TRAY_HEADING })
      .getByRole('row', { name: PRICING_ROW });
    await pricing.click();
    const dialog = page.getByRole('dialog', { name: 'pricing' });
    await expect(dialog).toBeVisible();
    expect(await isInFullscreen(dialog)).toBe(true);
  });
});
