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
const CUSTOM_PROVIDER = 'Other OpenAI-compatible server';
const SAVE = 'Save';
const SAVE_ANYWAY = 'Save anyway';
const NO_MODEL = 'No model';
const SAVED = 'Saved. Worth checking:';
// The provider list opens from the keyboard: near the foot of a dialog its
// popover can open over the trigger, and a mouse click's release would then
// pick whichever option landed under the pointer.

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

  test('the company model is chosen and kept, a role follows it, and clearing it is caught', async ({
    page,
    request,
  }) => {
    const auth = { Authorization: `Bearer ${fixture.token}` };
    const role = await request.post('/api/role', {
      headers: auth,
      data: {
        companyId: fixture.companyId,
        slug: 'writer',
        name: 'Writer',
        description: 'Made by admin.spec.ts',
        knowledgeDomains: [],
        mcpServerList: [],
        llmConfig: { provider: 'openai', model: 'gpt-5-mini' },
      },
    });
    expect(role.status()).toBe(201);
    const defaults = await request.get('/api/system/llm-defaults', {
      headers: auth,
    });
    const { chat: appDefault } = (await defaults.json()) as {
      chat: object | null;
    };

    // The company's chat model, saved and still there after a reload.
    await gotoSignedIn(page, `/company/${fixture.companyId}#admin/models`);
    const chat = page.getByRole('group', { name: 'Chat model' });
    await chat.getByRole('button', { name: /Provider$/ }).press('Enter');
    await page.getByRole('option', { name: CUSTOM_PROVIDER }).click();
    // example.com is on the testing stack's LLM_ALLOWED_HOSTS.
    await chat
      .getByRole('textbox', { name: 'Address' })
      .fill('http://example.com/v1');
    await chat.getByRole('combobox', { name: 'Model' }).fill('test-model');
    await page.getByRole('button', { name: SAVE, exact: true }).click();
    // The fixture has no company context, so every save comes back with a
    // warning: its appearing is the sign the save finished.
    await expect(page.getByText(SAVED)).toBeVisible();
    await page.reload();
    await expect(chat.getByRole('combobox', { name: 'Model' })).toHaveValue(
      'test-model',
    );

    // The role drops its own model for the company's.
    await page.goto(`/company/${fixture.companyId}#admin/roles`);
    await page.getByRole('button', { name: 'Writer', exact: true }).click();
    // The only dialog open; its name is the role's.
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: /Provider$/ }).press('Enter');
    await page.getByRole('option', { name: /Use the company’s model/ }).click();
    await dialog.getByRole('button', { name: SAVE, exact: true }).click();
    // The role has no knowledge domains, so it is warned about too.
    await expect(dialog.getByText(SAVED)).toBeVisible();
    // The heading's close button and the form's both say Close.
    await dialog
      .getByRole('button', { name: 'Close', exact: true })
      .first()
      .click();

    // Clearing the company's model leaves the role with whatever the app has.
    await page.goto(`/company/${fixture.companyId}#admin/models`);
    await chat.getByRole('button', { name: /Provider$/ }).press('Enter');
    await page
      .getByRole('option', { name: /^Use the app default|^None/ })
      .click();
    await page.getByRole('button', { name: SAVE, exact: true }).click();
    if (appDefault === null) {
      const confirm = page.getByRole('alertdialog');
      await expect(confirm).toContainText('Writer');
      await confirm.getByRole('button', { name: SAVE_ANYWAY }).click();
      await page.goto(`/company/${fixture.companyId}#admin/roles`);
      await expect(
        page.getByRole('row', { name: /Writer/ }).getByText(NO_MODEL),
      ).toBeVisible();
    } else {
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
    }
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

/*
 * A role's memories (002.06). The fixture company embeds with the stack's stub
 * model (run-all-tests starts it with STUB_LLM=true); without it, adding a
 * memory fails rather than skipping.
 */
const MEMORIES_TAB = 'Memories';
const NO_MEMORIES = 'This role has no memories yet';
const ADD_MEMORY = 'Add a memory';
const EDIT_MEMORY = 'Edit memory';
const MEMORY_FIELD = 'Memory';
const DELETE_MEMORY_HEADING = 'Delete this memory?';
const OUT_OF_DATE = 'Out of date';
const RELOAD = 'Reload';

/** A company that embeds with the stub model, and one role in it. */
interface MemoryFixture extends Fixture {
  readonly roleId: string;
  readonly roleName: string;
}

const makeMemoryFixture = async (
  request: APIRequestContext,
): Promise<MemoryFixture> => {
  const token = await getMachineToken(request);
  const slug = `memory-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const headers = { Authorization: `Bearer ${token}` };
  const company = await request.post('/api/company', {
    headers,
    data: {
      name: slug,
      slug,
      description: 'Created by admin.spec.ts',
      embeddingConfig: {
        provider: 'openai-compatible',
        model: 'stub-embed',
        baseUrl: 'http://stub-llm:3002/v1',
      },
    },
  });
  expect(company.status()).toBe(201);
  const { id: companyId } = (await company.json()) as { id: string };
  const roleName = `Keeper ${Math.random().toString(36).slice(2, 8)}`;
  const role = await request.post('/api/role', {
    headers,
    data: {
      companyId,
      slug: 'keeper',
      name: roleName,
      description: 'Remembers things',
      knowledgeDomains: [],
      mcpServerList: [],
    },
  });
  expect(role.status()).toBe(201);
  const { id: roleId } = (await role.json()) as { id: string };
  return { token, companyId, roleId, roleName };
};

test.describe('role memories', () => {
  let fixture: MemoryFixture;

  test.beforeEach(async ({ request }) => {
    fixture = await makeMemoryFixture(request);
  });

  test.afterEach(async ({ request }) => {
    await dropFixture(request, fixture);
  });

  test('a memory is added, reworded, seen changing elsewhere, and deleted', async ({
    page,
    request,
  }) => {
    await gotoSignedIn(page, `/company/${fixture.companyId}#admin/roles`);
    await page
      .getByRole('button', { name: fixture.roleName, exact: true })
      .click();
    const roleDialog = page.getByRole('dialog', { name: fixture.roleName });
    await roleDialog.getByRole('tab', { name: MEMORIES_TAB }).click();
    await expect(
      roleDialog.getByRole('heading', { name: NO_MEMORIES }),
    ).toBeVisible();

    // Add: the new memory is listed and focused.
    await roleDialog
      .getByRole('button', { name: ADD_MEMORY, exact: true })
      .click();
    const add = page.getByRole('dialog', { name: ADD_MEMORY });
    await add
      .getByRole('textbox', { name: MEMORY_FIELD, exact: true })
      .fill('Tea is £3 a box');
    await add.getByRole('button', { name: SAVE, exact: true }).click();
    // A save that never returns (e.g. no embedding model reachable) fails here.
    await expect(add).toBeHidden();
    const added = roleDialog.getByRole('rowheader', {
      name: 'Tea is £3 a box',
    });
    await expect(added).toBeFocused();

    // Edit: the wording changes in place.
    await roleDialog
      .getByRole('button', { name: `${EDIT_MEMORY}: Tea is £3 a box` })
      .click();
    const edit = page.getByRole('dialog', { name: EDIT_MEMORY });
    await edit
      .getByRole('textbox', { name: MEMORY_FIELD, exact: true })
      .fill('Tea is £4 a box');
    await edit.getByRole('button', { name: SAVE, exact: true }).click();
    await expect(
      roleDialog.getByRole('rowheader', { name: 'Tea is £4 a box' }),
    ).toBeVisible();

    // Elsewhere: a memory added through the API waits behind a notice.
    const elsewhere = await request.post(`/api/role/${fixture.roleId}/memory`, {
      headers: { Authorization: `Bearer ${fixture.token}` },
      data: { content: 'Deliveries come on Tuesdays' },
    });
    expect(elsewhere.status()).toBe(201);
    const notice = roleDialog.getByRole('group', { name: OUT_OF_DATE });
    await expect(notice).toBeVisible();
    await expect(
      roleDialog.getByRole('rowheader', {
        name: 'Deliveries come on Tuesdays',
      }),
    ).toHaveCount(0);
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations).toEqual([]);
    await notice.getByRole('button', { name: RELOAD, exact: true }).click();
    await expect(
      roleDialog.getByRole('rowheader', {
        name: 'Deliveries come on Tuesdays',
      }),
    ).toBeVisible();

    // Delete both: the empty state comes back.
    for (const content of ['Tea is £4 a box', 'Deliveries come on Tuesdays']) {
      await roleDialog
        .getByRole('button', { name: `Delete memory: ${content}` })
        .click();
      await page
        .getByRole('alertdialog', { name: DELETE_MEMORY_HEADING })
        .getByRole('button', { name: DELETE_CONFIRM, exact: true })
        .click();
    }
    await expect(
      roleDialog.getByRole('heading', { name: NO_MEMORIES }),
    ).toBeVisible();
  });
});
