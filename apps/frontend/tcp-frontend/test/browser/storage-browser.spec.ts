import AxeBuilder from '@axe-core/playwright';
import { writeFile } from 'node:fs/promises';
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
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
const DATA_TAB = 'Data';
const DATA_LIST = 'Data';
const DOCUMENTS_ITEM = 'Documents';
const TREE = 'Documents';
const UPLOAD_FILES = 'Upload files';
const DELETE = 'Delete';
const REFRESH = 'Refresh';
const HISTORY = 'History';
const REPLACE_HEADING = 'Replace 1 file?';
const REPLACE_CONFIRM = 'Replace';
const DELETE_HEADING = 'Delete 1 item?';
const RESTORE_HEADING = 'Restore this version?';
const RESTORE_CONFIRM = 'Restore';
const RESTORE_BUTTON = /^Restore the version from /;
const DOWNLOAD_NOTES = 'Download notes.md';
const DOCUMENTS_REGION = '[aria-labelledby="documents-heading"]';

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

/** A company whose `resources/` folder exists, made through the API only. */
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
  const slug = `storage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const company = await request.post('/api/company', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      name: slug,
      slug,
      description: 'Created by storage-browser.spec.ts',
    },
  });
  expect(company.status()).toBe(201);
  const { id: companyId } = (await company.json()) as { id: string };
  const fixture = { token, companyId };
  await putFile(request, fixture, 'resources/README.md', '# Company resources');
  return fixture;
};

/** Deleting the company cascades to its stored files. */
const dropFixture = async (request: APIRequestContext, fixture: Fixture) => {
  await request.delete(`/api/company/${fixture.companyId}`, {
    headers: { Authorization: `Bearer ${fixture.token}` },
  });
};

/** Opens Data → Documents. */
const openDocuments = async (page: Page, companyId: string) => {
  await gotoSignedIn(page, `/company/${companyId}#data`);
  await expect(page.getByRole('tab', { name: DATA_TAB })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page
    .getByRole('listbox', { name: DATA_LIST })
    .getByRole('option', { name: DOCUMENTS_ITEM })
    .click();
  await expect(page.getByRole('treegrid', { name: TREE })).toBeVisible();
};

/** The tree row showing `name`. */
const row = (page: Page, name: string): Locator =>
  page
    .getByRole('treegrid', { name: TREE })
    .getByRole('row')
    .filter({ has: page.getByText(name, { exact: true }) });

/** Clicking a row toggles its selection, so this selects or deselects it. */
const toggle = (page: Page, name: string) =>
  row(page, name).getByText(name, { exact: true }).click();

/** Opens a folder row through its chevron, once. */
const expand = async (page: Page, name: string) => {
  const folder = row(page, name);
  if ((await folder.getAttribute('aria-expanded')) !== 'true') {
    await folder.getByRole('button').first().click();
  }
  await expect(folder).toHaveAttribute('aria-expanded', 'true');
};

/** Selects only `resources/`, opened. */
const openResources = async (page: Page) => {
  await toggle(page, 'resources');
  await expand(page, 'resources');
};

/** Gives the "Upload files" input one in-memory file. */
const upload = (page: Page, name: string, text: string) =>
  page.locator('input[type=file]:not([webkitdirectory])').setInputFiles({
    name,
    mimeType: 'text/markdown',
    buffer: Buffer.from(text),
  });

/** Deselects `resources/` then selects `name` alone, so one file shows its preview. */
const previewFile = async (page: Page, name: string) => {
  if ((await row(page, 'resources').getAttribute('aria-selected')) === 'true') {
    await toggle(page, 'resources');
  }
  await toggle(page, name);
  await expect(page.getByRole('region', { name })).toBeVisible();
};

test.use({ storageState: hasSignInCredentials ? AUTH_STATE_PATH : undefined });

test.skip(
  !hasSignInCredentials || !hasMachineCredentials,
  'Requires TEST_USERNAME/TEST_PASSWORD (the signed-in session) and ' +
    'TEST_CLIENT_ID/TEST_CLIENT_SECRET (the machine-token fixtures) — see ' +
    'scripts/run-browser-tests.sh.',
);

test.describe('storage browser', () => {
  let fixture: Fixture;

  test.beforeEach(async ({ request }) => {
    fixture = await makeFixture(request);
  });

  test.afterEach(async ({ request }) => {
    await dropFixture(request, fixture);
  });

  test('Data → Documents shows the company folders', async ({ page }) => {
    await openDocuments(page, fixture.companyId);
    await expect(row(page, 'resources')).toBeVisible();
  });

  test('an uploaded file appears in its folder and previews', async ({
    page,
  }) => {
    await openDocuments(page, fixture.companyId);
    await openResources(page);
    await upload(page, 'notes.md', '# First\n');
    await expect(row(page, 'notes.md')).toBeVisible();
    await previewFile(page, 'notes.md');
    await expect(
      page
        .getByRole('region', { name: 'notes.md' })
        .getByRole('heading', { name: 'First' }),
    ).toBeVisible();
  });

  test('a name clash asks first, and an older version is restored', async ({
    page,
  }) => {
    await putFile(page.request, fixture, 'resources/notes.md', '# First\n');
    await openDocuments(page, fixture.companyId);
    await openResources(page);
    await previewFile(page, 'notes.md');
    const preview = page.getByRole('region', { name: 'notes.md' });
    await expect(preview.getByRole('heading', { name: 'First' })).toBeVisible();

    // The file is selected, so the upload goes to its folder.
    await upload(page, 'notes.md', '# Second\n');
    const replace = page.getByRole('alertdialog', { name: REPLACE_HEADING });
    await replace.getByRole('button', { name: REPLACE_CONFIRM }).click();
    await page.getByRole('button', { name: REFRESH }).click();
    await expect(
      preview.getByRole('heading', { name: 'Second' }),
    ).toBeVisible();

    await preview.getByText(HISTORY, { exact: true }).click();
    // Two versions: the current one has no restore button.
    await expect(preview.getByRole('row')).toHaveCount(3);
    await preview.getByRole('button', { name: RESTORE_BUTTON }).click();
    await page
      .getByRole('alertdialog', { name: RESTORE_HEADING })
      .getByRole('button', { name: RESTORE_CONFIRM })
      .click();
    await expect(preview.getByRole('heading', { name: 'First' })).toBeVisible();
  });

  test('a selected file downloads under its own name', async ({ page }) => {
    await putFile(page.request, fixture, 'resources/notes.md', '# First\n');
    await openDocuments(page, fixture.companyId);
    await openResources(page);
    await previewFile(page, 'notes.md');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: DOWNLOAD_NOTES }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('notes.md');
  });

  test('a file dropped on the strip is uploaded', async ({ page }) => {
    await openDocuments(page, fixture.companyId);
    await openResources(page);
    const strip = page.locator('.storage-browser__drop');
    await expect(strip).toBeVisible();
    // A synthetic DragEvent never reaches React Aria's drop target (the
    // constructed DataTransfer's effectAllowed stays "none"), so drive the
    // browser's own drag machinery with a real file on disk.
    const file = test.info().outputPath('dropped.md');
    await writeFile(file, '# Dropped\n');
    const box = await strip.boundingBox();
    expect(box).not.toBeNull();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;
    const cdp = await page.context().newCDPSession(page);
    const data = { items: [], files: [file], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
      await cdp.send('Input.dispatchDragEvent', { type, x, y, data });
    }
    await expect(row(page, 'dropped.md')).toBeVisible();
  });

  test('a file is deleted after asking, and focus stays in the tree', async ({
    page,
  }) => {
    await putFile(page.request, fixture, 'resources/gone.md', '# Gone\n');
    await openDocuments(page, fixture.companyId);
    await openResources(page);
    await previewFile(page, 'gone.md');
    await page.getByRole('button', { name: DELETE, exact: true }).click();
    await page
      .getByRole('alertdialog', { name: DELETE_HEADING })
      .getByRole('button', { name: DELETE })
      .click();
    await expect(row(page, 'gone.md')).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.activeElement?.closest('[role=treegrid]') !== null,
        ),
      )
      .toBe(true);
  });

  test('a read-only folder takes no uploads', async ({ page, request }) => {
    const res = await request.post(
      `/api/company/${fixture.companyId}/knowledge`,
      {
        headers: { Authorization: `Bearer ${fixture.token}` },
        multipart: {
          file: {
            name: 'x.md',
            mimeType: 'text/markdown',
            buffer: Buffer.from('---\ntitle: X\n---\n# X\n'),
          },
        },
      },
    );
    expect(res.status()).toBe(201);
    await openDocuments(page, fixture.companyId);
    await toggle(page, 'knowledge');
    await expect(
      page.getByRole('button', { name: UPLOAD_FILES }),
    ).toBeDisabled();
  });

  test('has no accessibility violations with a preview open', async ({
    page,
  }) => {
    await putFile(page.request, fixture, 'resources/notes.md', '# First\n');
    await openDocuments(page, fixture.companyId);
    await openResources(page);
    await previewFile(page, 'notes.md');
    await expect(
      page
        .getByRole('region', { name: 'notes.md' })
        .getByRole('heading', { name: 'First' }),
    ).toBeVisible();
    expect(
      (await new AxeBuilder({ page }).include(DOCUMENTS_REGION).analyze())
        .violations,
    ).toEqual([]);
  });
});
