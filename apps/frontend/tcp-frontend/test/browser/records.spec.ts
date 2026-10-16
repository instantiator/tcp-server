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
const DATA_TAB = 'Data';
const DATA_LIST = 'Data';
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
    // Skipping AG Grid's row-selection checkbox column (001.04).
    .locator('[role="gridcell"]:not([col-id="ag-Grid-SelectionColumn"])')
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

/** Opens the Data tab on `orders`. */
const openOrders = async (page: Page, companyId: string) => {
  await gotoSignedIn(page, `/company/${companyId}#data`);
  await expect(page.getByRole('tab', { name: DATA_TAB })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page
    .getByRole('listbox', { name: DATA_LIST })
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
      // Skipping AG Grid's row-selection checkbox column (001.04).
      .locator('[role="gridcell"]:not([col-id="ag-Grid-SelectionColumn"])')
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

/* Literals copied from `strings.ts` (001.05). */
const OUT_OF_DATE = 'Out of date';
const RELOAD = 'Reload';
const CHANGED_ELSEWHERE = '(changed elsewhere, so it cannot be edited)';
const DROPPED =
  'This table was deleted elsewhere. You can still read it here, but it cannot be changed.';
const ADD_ROW = 'Add a row to orders';

/** Changes and deletes made through the API: someone else, to this page. */
const elsewhere = (request: APIRequestContext, fixture: Fixture) => {
  const headers = { Authorization: `Bearer ${fixture.token}` };
  const base = `/api/company/${fixture.companyId}/records/tables/orders`;
  return {
    update: async (key: string, changes: Record<string, unknown>) => {
      const table = await request.get(base, { headers });
      const { rows } = (await table.json()) as {
        rows: { id: string; version: number; data: { order_id: string } }[];
      };
      const target = rows.find((r) => r.data.order_id === key);
      expect(target).toBeDefined();
      const res = await request.patch(`${base}/rows/${target?.id ?? ''}`, {
        headers,
        data: { changes, version: target?.version },
      });
      expect(res.status()).toBe(200);
    },
    add: async (data: Record<string, unknown>) => {
      const res = await request.post(`${base}/rows`, {
        headers,
        data: { data },
      });
      expect(res.status()).toBe(201);
    },
    drop: async () => {
      const res = await request.delete(base, { headers });
      expect(res.ok()).toBe(true);
    },
  };
};

test.describe('a record table changed elsewhere (001.05)', () => {
  let fixture: Fixture;

  test.beforeEach(async ({ request }) => {
    fixture = await makeFixture(request);
  });

  test.afterEach(async ({ request }) => {
    await dropFixture(request, fixture);
  });

  test('says so, locks the changed row, and shows the change on Reload', async ({
    page,
    request,
  }) => {
    await openOrders(page, fixture.companyId);
    await elsewhere(request, fixture).update('A1', { qty: 9 });

    const notice = page.getByRole('group', { name: OUT_OF_DATE });
    await expect(notice).toContainText('1 row changed');
    // The old value stays until Reload; the row says why it won't edit.
    await expect(cell(page, 'A1', 1)).toHaveText('2');
    await expect(cell(page, 'A1', 0)).toContainText(CHANGED_ELSEWHERE);
    await cell(page, 'A1', 1).click();
    await expect(cell(page, 'A1', 1).locator('input')).toHaveCount(0);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    await notice.getByRole('button', { name: RELOAD }).click();
    await expect(notice).toHaveCount(0);
    await expect(cell(page, 'A1', 1)).toHaveText('9');
    await expect(cell(page, 'A1', 0)).not.toContainText(CHANGED_ELSEWHERE);
  });

  test('keeps the Data tab counts current', async ({ page, request }) => {
    await openOrders(page, fixture.companyId);
    const option = page
      .getByRole('listbox', { name: DATA_LIST })
      .getByRole('option', { name: /^orders/ });
    await expect(option).toContainText('2 records');

    await elsewhere(request, fixture).add({ order_id: 'A3', qty: 1 });
    await expect(option).toContainText('3 records');
    await expect(page.getByRole('group', { name: OUT_OF_DATE })).toContainText(
      '1 row added',
    );
  });

  test('an old #tables/<name> link still opens that table under Data', async ({
    page,
  }) => {
    await gotoSignedIn(page, `/company/${fixture.companyId}#tables/orders`);
    await expect(page.getByRole('tab', { name: DATA_TAB })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('grid', { name: SHEET })).toBeVisible();
    await expect(page).toHaveURL(/#data\/tables\/orders$/);
  });

  test('keeps a table deleted elsewhere open, read-only', async ({
    page,
    request,
  }) => {
    await openOrders(page, fixture.companyId);
    await elsewhere(request, fixture).drop();

    await expect(page.getByRole('group', { name: OUT_OF_DATE })).toHaveText(
      DROPPED,
    );
    await expect(page.getByRole('button', { name: ADD_ROW })).toBeDisabled();
    await expect(cell(page, 'A1', 1)).toHaveText('2');
    await expect(
      page
        .getByRole('listbox', { name: DATA_LIST })
        .getByRole('option', { name: /^orders/ }),
    ).toHaveCount(0);
  });
});

/* Literals copied from `strings.ts` (001.06). */
const FEEDINGS_SHEET = 'feedings records';
const COLUMNS_MENU_ITEM = 'Columns…';
const COLUMNS_OUT_OF_DATE =
  "This table's columns were changed elsewhere. It cannot be edited until you reload.";
const KEY_NO_DELETE =
  'In a key, so it cannot be deleted. Take it out of the key first.';

/** The grid cell in `column` (0-based) of the `feedings` row dated `date`. */
const feedingCell = (page: Page, date: string, column: number) =>
  page
    .getByRole('grid', { name: FEEDINGS_SHEET })
    .getByRole('row')
    .filter({
      has: page.getByRole('gridcell', { name: new RegExp(`^${date}( |$)`) }),
    })
    .locator('[role="gridcell"]:not([col-id="ag-Grid-SelectionColumn"])')
    .nth(column);

const feedingHeader = (page: Page, name: string) =>
  page
    .getByRole('grid', { name: FEEDINGS_SHEET })
    .getByRole('columnheader', { name: new RegExp(`^${name}`) });

/** A `feedings` table with a two-field key and two rows, through the API only. */
const makeFeedings = async (
  request: APIRequestContext,
  fixture: Fixture,
  extraColumn?: string,
  counts?: [string, string],
) => {
  const headers = { Authorization: `Bearer ${fixture.token}` };
  const base = `/api/company/${fixture.companyId}/records/tables`;
  const created = await request.post(base, {
    headers,
    data: {
      name: 'feedings',
      purpose: 'One row per feeding.',
      schema: {
        type: 'object',
        properties: {
          feeding_date: { type: 'string', format: 'date' },
          feeding_time: { type: 'string' },
          note: { type: 'string' },
          ...(counts ? { count: { type: 'string' } } : {}),
        },
        required: ['feeding_date', 'feeding_time'],
      },
      primaryKey: ['feeding_date', 'feeding_time'],
    },
  });
  expect(created.status()).toBe(201);
  for (const data of [
    {
      feeding_date: '2026-10-01',
      feeding_time: '08:00',
      note: 'first',
      ...(counts ? { count: counts[0] } : {}),
    },
    {
      feeding_date: '2026-10-02',
      feeding_time: '08:00',
      note: 'second',
      ...(counts ? { count: counts[1] } : {}),
    },
  ]) {
    const added = await request.post(`${base}/feedings/rows`, {
      headers,
      data: { data },
    });
    expect(added.status()).toBe(201);
  }
  if (extraColumn !== undefined) {
    await addColumnElsewhere(request, fixture, extraColumn);
  }
};

/** Someone else adds a text column, with `chicken` for the rows already there. */
const addColumnElsewhere = async (
  request: APIRequestContext,
  fixture: Fixture,
  column: string,
) => {
  const res = await request.post(
    `/api/company/${fixture.companyId}/records/tables/feedings/columns`,
    {
      headers: { Authorization: `Bearer ${fixture.token}` },
      data: { column, type: 'string', default: 'chicken' },
    },
  );
  expect(res.status()).toBe(201);
};

const openFeedings = async (page: Page, companyId: string) => {
  await gotoSignedIn(page, `/company/${companyId}#data`);
  await page
    .getByRole('listbox', { name: DATA_LIST })
    .getByRole('option', { name: /^feedings/ })
    .click();
  await expect(page.getByRole('grid', { name: FEEDINGS_SHEET })).toBeVisible();
};

/** More, then Columns…: the dialog that changes the table's columns. */
const openColumns = async (page: Page) => {
  await page.getByRole('button', { name: 'More actions for feedings' }).click();
  await page.getByRole('menuitem', { name: COLUMNS_MENU_ITEM }).click();
  const dialog = page.getByRole('dialog', { name: 'Columns of feedings' });
  await expect(dialog).toBeVisible();
  return dialog;
};

test.describe('column changes (001.06)', () => {
  let fixture: Fixture;

  test.beforeEach(async ({ request }) => {
    fixture = await makeFixture(request);
  });

  test.afterEach(async ({ request }) => {
    await dropFixture(request, fixture);
  });

  test('a column is added from the dialog, with a value for existing rows', async ({
    page,
    request,
  }) => {
    await makeFeedings(request, fixture);
    await openFeedings(page, fixture.companyId);
    const dialog = await openColumns(page);
    await dialog.getByRole('button', { name: 'Add column' }).click();
    await dialog.getByLabel('Column name').fill('animal');
    await dialog.getByRole('radio', { name: 'Text' }).check();
    await dialog
      .getByLabel('Value for rows already in the table (optional)')
      .fill('chicken');
    await dialog.getByRole('button', { name: 'Add column' }).click();

    await expect(dialog).toBeHidden();
    await expect(feedingHeader(page, 'animal')).toBeVisible();
    for (const date of ['2026-10-01', '2026-10-02']) {
      await expect(
        feedingCell(page, date, 0)
          .locator('xpath=..')
          .locator('[col-id="animal"]'),
      ).toHaveText('chicken');
    }
  });

  test('a column is renamed', async ({ page, request }) => {
    await makeFeedings(request, fixture, 'animal');
    await openFeedings(page, fixture.companyId);
    const dialog = await openColumns(page);
    await dialog.getByRole('button', { name: 'Rename animal' }).click();
    await dialog.getByLabel('New name for animal').fill('species');
    await dialog.getByRole('button', { name: 'Rename', exact: true }).click();

    await expect(dialog).toBeHidden();
    await expect(feedingHeader(page, 'species')).toBeVisible();
    await expect(feedingHeader(page, 'animal')).toHaveCount(0);
  });

  test('the key is changed to include a column', async ({ page, request }) => {
    await makeFeedings(request, fixture, 'species');
    await openFeedings(page, fixture.companyId);
    let dialog = await openColumns(page);
    await dialog.getByRole('button', { name: 'Change key' }).click();
    // The checkbox input sits under its styled label, which takes the click.
    await dialog.getByText('species', { exact: true }).click();
    await dialog.getByRole('button', { name: 'Save key' }).click();
    await expect(dialog).toBeHidden();

    dialog = await openColumns(page);
    await expect(dialog).toContainText(
      'Key: feeding_date, feeding_time, species.',
    );

    // The same date and time now differ by species, so this is not a clash.
    const third = await request.post(
      `/api/company/${fixture.companyId}/records/tables/feedings/rows`,
      {
        headers: { Authorization: `Bearer ${fixture.token}` },
        data: {
          data: {
            feeding_date: '2026-10-01',
            feeding_time: '08:00',
            species: 'duck',
          },
        },
      },
    );
    expect(third.status()).toBe(201);
  });

  test('a column is deleted after asking, and a key column cannot be', async ({
    page,
    request,
  }) => {
    await makeFeedings(request, fixture);
    await openFeedings(page, fixture.companyId);
    const dialog = await openColumns(page);
    await expect(
      dialog.getByRole('button', { name: 'Delete feeding_time' }),
    ).toBeDisabled();
    await expect(dialog.getByText(KEY_NO_DELETE).first()).toBeVisible();

    await dialog.getByRole('button', { name: 'Delete note' }).click();
    const confirm = page.getByRole('alertdialog', {
      name: 'Delete note from feedings?',
    });
    await expect(
      confirm.getByRole('button', { name: 'Download a copy first' }),
    ).toBeVisible();
    await expect(confirm.getByRole('button', { name: 'No' })).toBeFocused();
    await confirm.getByRole('button', { name: 'Delete column' }).click();

    await expect(confirm).toBeHidden();
    await expect(feedingHeader(page, 'feeding_date')).toBeVisible();
    await expect(feedingHeader(page, 'note')).toHaveCount(0);
  });

  test('a column added elsewhere says so, locks the sheet, and shows on Reload', async ({
    page,
    request,
  }) => {
    await makeFeedings(request, fixture);
    await openFeedings(page, fixture.companyId);
    await addColumnElsewhere(request, fixture, 'animal');

    const notice = page.getByRole('group', { name: OUT_OF_DATE });
    await expect(notice).toContainText(COLUMNS_OUT_OF_DATE);
    await expect(feedingHeader(page, 'animal')).toHaveCount(0);
    await feedingCell(page, '2026-10-01', 2).click();
    await expect(
      feedingCell(page, '2026-10-01', 2).locator('input'),
    ).toHaveCount(0);

    await notice.getByRole('button', { name: RELOAD }).click();
    await expect(notice).toHaveCount(0);
    await expect(feedingHeader(page, 'animal')).toBeVisible();
  });

  test('a text column becomes whole numbers, blanking what will not convert', async ({
    page,
    request,
  }) => {
    await makeFeedings(request, fixture, undefined, ['12', 'lots']);
    await openFeedings(page, fixture.companyId);
    const dialog = await openColumns(page);
    await dialog
      .getByRole('button', { name: 'Change the type of count' })
      .click();
    // The radio input sits under its styled label, which takes the click.
    await dialog.getByText('Whole number', { exact: true }).click();
    await dialog.getByRole('button', { name: 'Change type' }).click();

    const confirm = page.getByRole('alertdialog', {
      name: 'Blank values in count?',
    });
    await expect(confirm).toContainText('"lots"');
    await expect(
      confirm.getByRole('button', { name: 'Download a copy first' }),
    ).toBeVisible();
    await expect(confirm.getByRole('button', { name: 'No' })).toBeFocused();
    await confirm
      .getByRole('button', { name: 'Blank them and change type' })
      .click();

    await expect(confirm).toBeHidden();
    await expect(dialog).toBeHidden();
    const countOf = (date: string) =>
      feedingCell(page, date, 0)
        .locator('xpath=..')
        .locator('[col-id="count"]');
    await expect(countOf('2026-10-01')).toHaveText('12');
    await expect(countOf('2026-10-02')).toHaveText('');
  });

  test('a unique key is added, stops a clash and deletion, then is dropped', async ({
    page,
    request,
  }) => {
    await makeFeedings(request, fixture);
    await openFeedings(page, fixture.companyId);
    let dialog = await openColumns(page);
    await dialog.getByRole('button', { name: 'Add unique key' }).click();
    await dialog.getByText('note', { exact: true }).click();
    await dialog.getByRole('button', { name: 'Add unique key' }).last().click();
    await expect(dialog).toBeHidden();

    dialog = await openColumns(page);
    await expect(dialog).toContainText('Also unique:');
    await expect(dialog).toContainText('note');
    await expect(
      dialog.getByRole('button', { name: 'Delete note' }),
    ).toBeDisabled();

    const clash = () =>
      request.post(
        `/api/company/${fixture.companyId}/records/tables/feedings/rows`,
        {
          headers: { Authorization: `Bearer ${fixture.token}` },
          data: {
            data: {
              feeding_date: '2026-10-03',
              feeding_time: '08:00',
              note: 'first',
            },
          },
        },
      );
    expect((await clash()).status()).toBe(409);

    await dialog.getByRole('button', { name: 'Drop unique key note' }).click();
    const confirm = page.getByRole('alertdialog', {
      name: 'Drop the unique key on note?',
    });
    await confirm.getByRole('button', { name: 'Drop unique key' }).click();
    await expect(confirm).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    dialog = await openColumns(page);
    await expect(
      dialog.getByRole('button', { name: 'Delete note' }),
    ).toBeEnabled();
    expect((await clash()).status()).toBe(201);
  });
});
