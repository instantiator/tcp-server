import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { AUTH_STATE_PATH, hasSignInCredentials } from './auth-state';
import { gotoSignedIn } from './signed-in';

/*
 * 002.10: uploads through the storage browser's doors. Knowledge goes in
 * through the knowledge route (converted, then indexed); a task's materials
 * through the materials route. Each asks once, as an alertdialog, first.
 */

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
const UPLOAD = 'Upload';
const CANCEL = 'Cancel';
const KNOWLEDGE_QUESTION = 'Upload 1 file to knowledge?';
const MATERIALS_QUESTION = 'Add 1 file to the task’s materials?';
const REPLACE_HEADING = 'Replace 1 file?';
const REPLACE_CONFIRM = 'Replace';
const KNOWLEDGE_TAB = 'Knowledge';
const ROLE_NAME = 'Writer';

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

/** A company that embeds with the stub model, a role, shared knowledge and a ready task. */
interface Fixture {
  readonly token: string;
  readonly companyId: string;
  readonly taskRequest: string;
}

const markdown = (name: string, text: string) => ({
  file: { name, mimeType: 'text/markdown', buffer: Buffer.from(text) },
});

const makeFixture = async (request: APIRequestContext): Promise<Fixture> => {
  const token = await getMachineToken(request);
  const headers = { Authorization: `Bearer ${token}` };
  // `fullyParallel` runs every test at once; the random half keeps slugs apart.
  const slug = `knowledge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const company = await request.post('/api/company', {
    headers,
    data: {
      name: slug,
      slug,
      description: 'Created by knowledge-upload.spec.ts',
      embeddingConfig: {
        provider: 'openai-compatible',
        model: 'stub-embed',
        baseUrl: 'http://stub-llm:3002/v1',
      },
    },
  });
  expect(company.status()).toBe(201);
  const { id: companyId } = (await company.json()) as { id: string };
  const role = await request.post('/api/role', {
    headers,
    data: {
      companyId,
      slug: 'writer',
      name: ROLE_NAME,
      description: 'Writes things',
      knowledgeDomains: [],
      mcpServerList: [],
    },
  });
  expect(role.status()).toBe(201);
  // A shared document, so knowledge/shared/ is there to choose. A `.md` is
  // stored as it is, so it must already be OKF, with front matter.
  const seed = await request.post(`/api/company/${companyId}/knowledge`, {
    headers,
    multipart: markdown(
      'seed.md',
      '---\ntitle: Seed\n---\n\nA first document.',
    ),
  });
  expect(seed.status()).toBe(201);
  const taskRequest = `Write a report ${Math.random().toString(36).slice(2, 6)}`;
  const task = await request.post('/api/task', {
    headers,
    data: { companyId, request: taskRequest },
  });
  expect(task.status()).toBe(201);
  const { id: taskId } = (await task.json()) as { id: string };
  // A first material, so the task's materials/ folder is there to choose.
  const material = await request.post(`/api/task/${taskId}/materials`, {
    headers,
    multipart: markdown('brief.md', '# Brief'),
  });
  expect(material.status()).toBe(201);
  return { token, companyId, taskRequest };
};

/** Deleting the company cascades to its roles, tasks and stored files. */
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

/** The tree row whose name starts with `name`, inside `scope`. */
const row = (scope: Page | Locator, name: string | RegExp): Locator =>
  scope
    .getByRole('row', {
      name: typeof name === 'string' ? new RegExp(`^${name}`) : name,
    })
    .first();

/** Opens a folder row through its chevron, once. */
const expand = async (folder: Locator) => {
  if ((await folder.getAttribute('aria-expanded')) !== 'true') {
    await folder.getByRole('button').first().click();
  }
  await expect(folder).toHaveAttribute('aria-expanded', 'true');
};

/**
 * Picks one file through "Upload files", as a person does: the button is
 * pressed, so it keeps focus while the chooser is open.
 */
const pick = async (
  page: Page,
  scope: Page | Locator,
  name: string,
  text: string,
) => {
  const chooser = page.waitForEvent('filechooser');
  await scope.getByRole('button', { name: UPLOAD_FILES }).click();
  await (
    await chooser
  ).setFiles({
    name,
    mimeType: 'text/plain',
    buffer: Buffer.from(text),
  });
};

/** No axe violations inside the open alertdialog. */
const expectAccessibleDialog = async (page: Page) => {
  expect(
    (await new AxeBuilder({ page }).include('[role="alertdialog"]').analyze())
      .violations,
  ).toEqual([]);
};

test.use({ storageState: hasSignInCredentials ? AUTH_STATE_PATH : undefined });

test.skip(
  !hasSignInCredentials || !hasMachineCredentials,
  'Requires TEST_USERNAME/TEST_PASSWORD (the signed-in session) and ' +
    'TEST_CLIENT_ID/TEST_CLIENT_SECRET (the machine-token fixtures) — see ' +
    'scripts/run-browser-tests.sh.',
);

test.describe('uploads through the storage browser’s doors', () => {
  let fixture: Fixture;

  test.beforeEach(async ({ request }) => {
    fixture = await makeFixture(request);
  });

  test.afterEach(async ({ request }) => {
    await dropFixture(request, fixture);
  });

  test('Data → Documents uploads into shared knowledge after asking, and asks again before replacing', async ({
    page,
  }) => {
    await openDocuments(page, fixture.companyId);
    const tree = page.getByRole('treegrid', { name: TREE });
    await expand(row(tree, 'knowledge'));
    const shared = row(tree, 'shared');
    await shared.getByText('shared', { exact: true }).click();

    // Cancel first: nothing is sent, and focus is back on Upload files.
    await pick(page, page, 'notes.txt', 'Some notes.');
    let question = page.getByRole('alertdialog', { name: KNOWLEDGE_QUESTION });
    await expect(question).toContainText('notes.txt → notes.md');
    await expectAccessibleDialog(page);
    await question.getByRole('button', { name: CANCEL }).press('Enter');
    await expect(question).toBeHidden();
    await expect(
      page.getByRole('button', { name: UPLOAD_FILES }),
    ).toBeFocused();

    // Then for real, from the keyboard: the file appears under its new name.
    await pick(page, page, 'notes.txt', 'Some notes.');
    question = page.getByRole('alertdialog', { name: KNOWLEDGE_QUESTION });
    await question.getByRole('button', { name: UPLOAD }).press('Enter');
    await expect(question).toBeHidden();
    await expand(shared);
    await expect(row(tree, 'notes.md')).toBeVisible();

    // The same name again: asked once more, then "Replace?" by its stored name.
    await shared.getByText('shared', { exact: true }).click();
    if ((await shared.getAttribute('aria-selected')) !== 'true') {
      await shared.getByText('shared', { exact: true }).click();
    }
    await pick(page, page, 'notes.txt', 'Newer notes.');
    await page
      .getByRole('alertdialog', { name: KNOWLEDGE_QUESTION })
      .getByRole('button', { name: UPLOAD })
      .click();
    const replace = page.getByRole('alertdialog', { name: REPLACE_HEADING });
    await expect(replace).toContainText('notes.md');
    await expectAccessibleDialog(page);
    await replace.getByRole('button', { name: REPLACE_CONFIRM }).click();
    await expect(replace).toBeHidden();
    await expect(row(tree, 'notes.md')).toHaveCount(1);
  });

  test('the role dialog’s Knowledge tab uploads into the role’s folder, and the index follows', async ({
    page,
  }) => {
    await gotoSignedIn(page, `/company/${fixture.companyId}#admin/roles`);
    await page.getByRole('button', { name: ROLE_NAME, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: ROLE_NAME });
    await dialog.getByRole('tab', { name: KNOWLEDGE_TAB }).click();

    await pick(
      page,
      dialog,
      'style.md',
      '---\ntitle: House style\n---\n\nShort sentences.',
    );
    await page
      .getByRole('alertdialog', { name: KNOWLEDGE_QUESTION })
      .getByRole('button', { name: UPLOAD })
      .click();
    await expect(row(dialog, 'style.md')).toBeVisible();
    // The upload queued a rebuild; the status polls until it is indexed.
    await expect(dialog.getByText(/1 indexed passage/)).toBeVisible({
      timeout: 30_000,
    });
  });

  test("a task's materials take a file through the materials route, after asking", async ({
    page,
  }) => {
    await openDocuments(page, fixture.companyId);
    const tree = page.getByRole('treegrid', { name: TREE });
    await expand(row(tree, 'tasks'));
    await expand(row(tree, new RegExp(fixture.taskRequest)));
    const materials = row(tree, 'materials');
    await materials.getByText('materials', { exact: true }).click();

    await pick(page, page, 'notes.txt', 'Extra notes.');
    const question = page.getByRole('alertdialog', {
      name: MATERIALS_QUESTION,
    });
    await expectAccessibleDialog(page);
    await question.getByRole('button', { name: UPLOAD }).click();
    await expect(question).toBeHidden();
    await expand(materials);
    await expect(row(tree, 'notes.txt')).toBeVisible();
  });
});
