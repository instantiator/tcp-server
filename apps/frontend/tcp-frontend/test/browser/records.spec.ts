import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
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
const CLOSE_DETAILS_LABEL = 'Close details';
const CABINET_PICKER_LABEL = 'Filing cabinet (record tables)';
const TRAY_HEADING = 'Record tables';
const CABINET_TITLE = 'Filing cabinet';
const TABLES_TAB = 'Tables';
const TABLES_LIST = 'Record tables';
const SHEET = 'orders records';
const DOWNLOAD_ALL = 'Download all tables as a zip';
const NO_TABLES =
  'No record tables yet. Agents make them when they keep records such as orders or stock.';

/**
 * How far above its tile centre the cabinet's hit zone sits:
 * `FURNITURE_SIZES.filingCabinet.height / 2` (28 / 2) in `drawFurniture.ts`.
 */
const CABINET_ZONE_LIFT = 14;

/** A file name stamped `YYYY-MM-DD HH-mm-ss`, then the company slug and a label. */
const downloadName = (slug: string, label: string, ext: string) =>
  new RegExp(
    `^\\d{4}-\\d\\d-\\d\\d \\d\\d-\\d\\d-\\d\\d ${slug} ${label}\\.${ext}$`,
  );

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

/** One company with an `orders` table holding A1 and A2, through the API only. */
interface Fixture {
  readonly token: string;
  readonly companyId: string;
  readonly slug: string;
}

const makeFixture = async (request: APIRequestContext): Promise<Fixture> => {
  const token = await getMachineToken(request);
  const headers = { Authorization: `Bearer ${token}` };
  // `fullyParallel` runs every test at once; the random half keeps slugs apart.
  const slug = `records-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const company = await request.post('/api/company', {
    headers,
    data: { name: slug, slug, description: 'Created by records.spec.ts' },
  });
  expect(company.status()).toBe(201);
  const { id: companyId } = (await company.json()) as { id: string };
  const base = `/api/company/${companyId}/records`;
  const table = await request.post(`${base}/tables`, {
    headers,
    data: {
      name: 'orders',
      purpose: 'One row per order.',
      schema: {
        type: 'object',
        properties: {
          order_id: { type: 'string' },
          qty: { type: 'integer', minimum: 1 },
        },
        required: ['order_id', 'qty'],
      },
      primaryKey: ['order_id'],
    },
  });
  expect(table.status()).toBe(201);
  for (const data of [
    { order_id: 'A1', qty: 2 },
    { order_id: 'A2', qty: 5 },
  ]) {
    const added = await request.post(`${base}/tables/orders/rows`, {
      headers,
      data: { data },
    });
    expect(added.status()).toBe(201);
  }
  return { token, companyId, slug };
};

/** Deleting the company cascades to its record tables. */
const dropFixture = async (request: APIRequestContext, fixture: Fixture) => {
  await request.delete(`/api/company/${fixture.companyId}`, {
    headers: { Authorization: `Bearer ${fixture.token}` },
  });
};

/**
 * The grid cell in `column` (0-based) of the row whose key is `key`. The key
 * cell's name may end with a hidden mark, such as "(added)".
 */
const cell = (page: Page, key: string, column: number) =>
  page
    .getByRole('grid', { name: SHEET })
    .getByRole('row')
    .filter({
      has: page.getByRole('gridcell', { name: new RegExp(`^${key}( |$)`) }),
    })
    .getByRole('gridcell')
    .nth(column);

/**
 * Gives a cell keyboard focus without editing it. A click opens the cell's
 * editor (single-click editing), and the editor opens a moment later, so the
 * Escape that closes it must wait for it. Pressed too early, on a slow runner,
 * the Escape is lost and the next keys type into the editor (CI, 2026-10-11).
 */
const focusCell = async (page: Page, key: string, column: number) => {
  const target = cell(page, key, column);
  await target.click();
  const editor = target.locator('input');
  await expect(editor).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(target).toBeFocused();
};

/** Opens the Tables tab on `orders`. */
const openOrders = async (page: Page, companyId: string) => {
  await gotoSignedIn(page, `/company/${companyId}#tables`);
  await expect(page.getByRole('tab', { name: TABLES_TAB })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page
    .getByRole('listbox', { name: TABLES_LIST })
    .getByRole('option', { name: /^orders/ })
    .click();
  await expect(page.getByRole('grid', { name: SHEET })).toBeVisible();
};

test.use({ storageState: hasSignInCredentials ? AUTH_STATE_PATH : undefined });

test.skip(
  !hasSignInCredentials || !hasMachineCredentials,
  'Requires TEST_USERNAME/TEST_PASSWORD (the signed-in session) and ' +
    'TEST_CLIENT_ID/TEST_CLIENT_SECRET (the machine-token fixtures) — see ' +
    'scripts/run-browser-tests.sh.',
);

test.describe('record tables', () => {
  let fixture: Fixture;

  test.beforeEach(async ({ request }) => {
    fixture = await makeFixture(request);
  });

  test.afterEach(async ({ request }) => {
    await dropFixture(request, fixture);
  });

  test('the filing cabinet opens a tray of tables, from the picker and the office', async ({
    page,
  }) => {
    await gotoSignedIn(page, `/company/${fixture.companyId}`);
    const canvas = page
      .getByRole('group', { name: 'Office view' })
      .locator('canvas');

    await page.getByRole('button', { name: SHOW_DETAILS_LABEL }).click();
    await page.getByRole('option', { name: CABINET_PICKER_LABEL }).click();
    const tray = page.getByRole('complementary', { name: TRAY_HEADING });
    await expect(tray).toBeVisible();
    const row = tray.getByRole('row', { name: /orders/ });
    await expect(row.getByRole('cell').first()).toHaveText('2');
    expect(
      (await new AxeBuilder({ page }).include('aside').analyze()).violations,
    ).toEqual([]);

    // Follow centres the camera on the cabinet, so the canvas's centre, lifted
    // onto its hit zone, is where the pointer meets it.
    await page.getByRole('button', { name: FOLLOW_LABEL }).click();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2 - CABINET_ZONE_LIFT;
    await page.mouse.move(cx, cy);
    await expect(page.getByRole('tooltip')).toContainText(CABINET_TITLE);

    await page.getByRole('button', { name: CLOSE_DETAILS_LABEL }).click();
    await expect(tray).toBeHidden();
    await page.mouse.click(cx, cy);
    await expect(tray).toBeVisible();

    await tray.getByRole('button', { name: 'orders', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'orders' });
    await expect(dialog.getByRole('grid', { name: SHEET })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });

  test('a cell is edited and the edit undone from the keyboard alone', async ({
    page,
  }) => {
    await openOrders(page, fixture.companyId);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    // Focus the key cell, then everything is the keyboard. Each step waits
    // for the grid to reach its state before the next key, as a person would.
    await focusCell(page, 'A1', 0);
    await page.keyboard.press('ArrowRight');
    const qty = cell(page, 'A1', 1);
    await expect(qty).toBeFocused();
    await page.keyboard.press('Enter');
    const editor = qty.locator('input');
    await expect(editor).toBeFocused();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('9');
    await expect(editor).toHaveValue('9');
    await page.keyboard.press('Enter');
    await expect(qty).toContainText('9');
    await expect(qty).toContainText('(changed)');
    await expect(qty).toBeFocused();

    await page.keyboard.press('ControlOrMeta+z');
    await expect(qty).toHaveText('2');
    await expect(
      page.getByRole('button', { name: 'Nothing to undo' }),
    ).toBeDisabled();
  });

  test('a column sorts from its header', async ({ page }) => {
    await openOrders(page, fixture.companyId);
    const qty = page
      .getByRole('grid', { name: SHEET })
      .getByRole('columnheader', { name: /^qty/ });
    await qty.click();
    await expect(qty).toHaveAttribute('aria-sort', 'ascending');
    const firstKey = page
      .getByRole('grid', { name: SHEET })
      .getByRole('row')
      .nth(1)
      .getByRole('gridcell')
      .first();
    await expect(firstKey).toHaveText('A1');
  });

  test('a row is added, then deleted after asking', async ({ page }) => {
    await openOrders(page, fixture.companyId);
    await page.getByRole('button', { name: 'Add a row to orders' }).click();
    const form = page.getByRole('dialog', { name: 'Add a row to orders' });
    await form.getByLabel('order_id').fill('A3');
    await form.getByLabel('qty').fill('4');
    await form.getByRole('button', { name: 'Add row' }).click();
    await expect(form).toBeHidden();
    await expect(cell(page, 'A3', 1)).toHaveText(/^4/);

    await focusCell(page, 'A3', 0);
    await page.getByRole('button', { name: 'Delete row A3' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Delete row A3?' });
    await confirm.getByRole('button', { name: 'Delete row' }).click();
    await expect(
      page
        .getByRole('grid', { name: SHEET })
        .getByRole('gridcell', { name: /^A3( |$)/ }),
    ).toHaveCount(0);
  });

  test('downloads are named by the time, company and table', async ({
    page,
  }) => {
    await openOrders(page, fixture.companyId);
    const [csv] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download orders as CSV' }).click(),
    ]);
    expect(csv.suggestedFilename()).toMatch(
      downloadName(fixture.slug, 'orders', 'csv'),
    );
    const [zip] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: DOWNLOAD_ALL }).click(),
    ]);
    expect(zip.suggestedFilename()).toMatch(
      downloadName(fixture.slug, 'tables', 'zip'),
    );
  });

  test('a table is cleared, then deleted, each after asking', async ({
    page,
  }) => {
    await openOrders(page, fixture.companyId);
    const more = page.getByRole('button', { name: 'More actions for orders' });

    await more.click();
    await page.getByRole('menuitem', { name: 'Clear table…' }).click();
    const clear = page.getByRole('alertdialog', { name: 'Clear orders?' });
    await expect(clear).toContainText('This deletes 2 records.');
    await clear.getByRole('button', { name: 'Clear table' }).click();
    await expect(page.getByRole('option', { name: /^orders/ })).toContainText(
      '0 records',
    );

    await more.click();
    await page.getByRole('menuitem', { name: 'Delete table…' }).click();
    await page
      .getByRole('alertdialog', { name: 'Delete orders?' })
      .getByRole('button', { name: 'Delete table' })
      .click();
    await expect(page.getByText(NO_TABLES)).toBeVisible();
  });
});
