// The "Add new" control (003.01): a floating button on the company page that
// creates a task or starts a chat, the same menu reused inside the chat
// dialog's own title bar, and the office view role tray's "Chat with…"
// button. Two credential sets are required and neither is optional: the
// human session to view the page, and the machine token to create what it
// shows, exactly as `company-activity.spec.ts` and
// `company-visualisation.spec.ts` use for their own fixtures. There is no
// shared helper module between browser specs (each is a self-contained black
// box, same as the api/smoke tiers), so `getMachineToken` below is a
// deliberate duplicate of those files', not a shared import.
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
 * Literals copied from `apps/frontend/tcp-frontend/src/strings.ts` by hand,
 * the same way every other browser spec does — `strings.ts` is app source,
 * not something this tier can import, so these are kept in step manually if
 * the copy there ever changes.
 *
 * `addNew.*`, `task.create.*`, `chat.*`: see `AddNewMenu.tsx`,
 * `CreateTaskDialog.tsx` and `ChatConversation.tsx`.
 */
const ADD_NEW_TRIGGER = 'Add new';
const CREATE_TASK_ITEM = 'Create a new task';
const NEW_CHAT_ITEM = 'New chat';
const TASK_DIALOG_HEADING = 'New task';
const TASK_REQUEST_LABEL = 'What needs doing';
const TASK_START_LABEL = 'Start this task now';
const TASK_SUBMIT_LABEL = 'Create task';
const CHAT_DIALOG_HEADING = 'Chats';
const TASKS_HEADING = 'Tasks';

/** `chat.conversation.label` and `visualisation.tray.chatWithRole` both read this. */
const chatWithRole = (role: string): string => `Chat with ${role}`;
/** `chat.close`. */
const closeChatName = (role: string): string => `Close the chat with ${role}`;

/*
 * `visualisation.*` literals, copied the same way — see
 * `company-visualisation.spec.ts`, which this mirrors for the office-view
 * half of this file.
 */
const SHOW_DETAILS_LABEL = 'Show details for';
/** `visualisation.picker.role` and `visualisation.tray.roleHeading` both read this. */
const roleLabel = (name: string): string => `Role: ${name}`;

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

test.describe('add new', () => {
  let token: string;
  let companyId: string;

  // One company for the whole file, the same posture `company-activity.spec.ts`
  // and `company-visualisation.spec.ts` take — real fixtures, not seeded data
  // (ADR-016's black-box posture applied to this tier too). Each test creates
  // its own role(s) inline, so no test depends on another's state and none of
  // them race each other over a shared role or task.
  test.beforeAll(async ({ request }) => {
    token = await getMachineToken(request);
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    const company = await request.post('/api/company', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: `add-new browser test ${suffix}`,
        slug: `add-new-${suffix}`,
        description: 'Created by add-new.spec.ts',
      },
    });
    expect(company.status()).toBe(201);
    companyId = ((await company.json()) as CreatedCompany).id;
  });

  test.afterAll(async ({ request }) => {
    // `TcpCompany` cascades its roles and tasks, so nothing else to clean up.
    await request.delete(`/api/company/${companyId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  });

  const createRole = async (
    request: APIRequestContext,
    name: string,
  ): Promise<string> => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const role = await request.post('/api/role', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        companyId,
        slug: `add-new-role-${suffix}`,
        name,
        description: 'Created by add-new.spec.ts',
        knowledgeDomains: [],
        mcpServerList: [],
      },
    });
    expect(role.status()).toBe(201);
    return ((await role.json()) as CreatedRole).id;
  };

  /** The floating button, right after the `h1` — present on every company tab. */
  const addNewButton = (page: Page) =>
    page.getByRole('button', { name: ADD_NEW_TRIGGER, exact: true });

  test('creates a task from the floating button, and returns focus to it', async ({
    page,
  }) => {
    await gotoSignedIn(page, `/company/${companyId}`);

    await addNewButton(page).click();
    await page.getByRole('menuitem', { name: CREATE_TASK_ITEM }).click();

    const dialog = page.getByRole('dialog', { name: TASK_DIALOG_HEADING });
    await expect(dialog).toBeVisible();
    // Not asserting which element specifically — `AddNewMenu.test.tsx` makes
    // the same choice — only that the modal actually moved focus into itself.
    const focusIsInsideDialog = await dialog.evaluate((element) =>
      element.contains(document.activeElement),
    );
    expect(focusIsInsideDialog).toBe(true);

    await dialog
      .getByRole('textbox', { name: TASK_REQUEST_LABEL })
      .fill('Created by add-new.spec.ts');

    // Left unchecked: this tier's deployment has no tcp-agent worker to run
    // a start job (memory: "Office view: no agent E2E"), so leaving the task
    // `ready` rather than queuing a start that nothing will ever process
    // keeps the fixture clean — the same posture the other browser specs
    // take by never calling `/start` themselves. The checkbox defaults to
    // checked and a direct `.click()` misses it — `base.css` styles its label
    // over the visually hidden input, the same reason
    // `company-visualisation.spec.ts`'s Roles toggle test uses the keyboard.
    const startCheckbox = dialog.getByRole('checkbox', {
      name: TASK_START_LABEL,
    });
    await startCheckbox.focus();
    await page.keyboard.press('Space');
    await expect(startCheckbox).not.toBeChecked();

    await dialog.getByRole('button', { name: TASK_SUBMIT_LABEL }).click();
    await expect(dialog).toBeHidden();

    // `MenuTrigger` returns focus to its own button once the dialog it opened
    // closes (003.01 decision 4).
    await expect(addNewButton(page)).toBeFocused();

    // Cheap to check: the row appears without needing its server-issued
    // shortcode — this is the only test in the file that creates a task, so
    // exactly one row is unambiguous.
    // 005.01: the single "Activity" tab is gone — each activity list is now
    // its own tab, named with a trailing count badge once it has loaded, so
    // this matches by a regex anchored at the start rather than an exact name.
    await page
      .getByRole('tab', { name: new RegExp(`^${TASKS_HEADING}`) })
      .click();
    const tasksRegion = page.getByRole('region', { name: TASKS_HEADING });
    await expect(
      tasksRegion.getByRole('button', { name: /^Open task / }),
    ).toHaveCount(1);
  });

  test("starts a chat from the floating button, then a second from the dialog's own Add new menu", async ({
    page,
    request,
  }) => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const roleAName = `Add new role A ${suffix}`;
    const roleBName = `Add new role B ${suffix}`;
    await createRole(request, roleAName);
    await createRole(request, roleBName);

    await gotoSignedIn(page, `/company/${companyId}`);

    await addNewButton(page).click();
    await page.getByRole('menuitem', { name: NEW_CHAT_ITEM }).click();
    await page.getByRole('menuitem', { name: roleAName }).click();

    const chatDialog = page.getByRole('dialog', { name: CHAT_DIALOG_HEADING });
    await expect(chatDialog).toBeVisible();
    const firstPanel = page.getByRole('region', {
      name: chatWithRole(roleAName),
    });
    await expect(firstPanel).toBeVisible();

    // The dialog's own control offers chats only (000.05), so it is named
    // "New chat" and lists the roles straight away.
    await chatDialog
      .getByRole('button', { name: NEW_CHAT_ITEM, exact: true })
      .click();
    await page.getByRole('menuitem', { name: roleBName }).click();

    const secondPanel = page.getByRole('region', {
      name: chatWithRole(roleBName),
    });
    await expect(secondPanel).toBeVisible();
    // The first panel is untouched — a plain vertical stack, not tabs
    // (`ChatDialog.tsx`), so adding a panel never unmounts another.
    await expect(firstPanel).toBeVisible();
  });

  test("starts a chat from the office view's role tray, and returns focus to its button on close", async ({
    page,
    request,
  }) => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const roleName = `Add new tray role ${suffix}`;
    await createRole(request, roleName);

    await gotoSignedIn(page, `/company/${companyId}`);

    await page.getByRole('button', { name: SHOW_DETAILS_LABEL }).click();
    await page.getByRole('option', { name: roleLabel(roleName) }).click();

    const tray = page.getByRole('complementary', { name: roleLabel(roleName) });
    await expect(tray).toBeVisible();

    const chatButton = tray.getByRole('button', {
      name: chatWithRole(roleName),
    });
    await chatButton.click();

    const chatDialog = page.getByRole('dialog', { name: CHAT_DIALOG_HEADING });
    await expect(chatDialog).toBeVisible();
    const panel = page.getByRole('region', { name: chatWithRole(roleName) });
    await expect(panel).toBeVisible();

    // The only open panel: closing it empties the conversation list, which
    // closes the dialog with it (`ChatProvider.tsx`'s
    // `isOpen={isOpen && conversations.length > 0}`) — the same behaviour
    // `company-activity.spec.ts`'s close test exercises from Activity → Chats.
    // Closing here returns focus to whatever opened the dialog, which is the
    // tray's own button — the tray stays mounted underneath throughout
    // (003.01 stage 4).
    await page.getByRole('button', { name: closeChatName(roleName) }).click();
    await expect(chatDialog).toBeHidden();
    await expect(chatButton).toBeFocused();
  });

  test('opens a chat with the keyboard-only Add new walk', async ({
    page,
    request,
  }) => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const roleName = `Add new keyboard role ${suffix}`;
    await createRole(request, roleName);

    await gotoSignedIn(page, `/company/${companyId}`);

    // Focus the button, Enter opens the menu on its first item, ArrowDown
    // reaches "New chat", ArrowRight opens its submenu focused on the first
    // (only) role, Enter chooses it — the same walk
    // `AddNewMenu.test.tsx`'s keyboard-navigation describe proves at the
    // component tier, driven here against a real browser instead.
    await addNewButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('menuitem', { name: CREATE_TASK_ITEM }),
    ).toBeFocused();

    await page.keyboard.press('ArrowDown');
    await expect(
      page.getByRole('menuitem', { name: NEW_CHAT_ITEM }),
    ).toBeFocused();

    await page.keyboard.press('ArrowRight');
    const roleItem = page.getByRole('menuitem', { name: roleName });
    await expect(roleItem).toBeFocused();

    await page.keyboard.press('Enter');

    await expect(
      page.getByRole('dialog', { name: CHAT_DIALOG_HEADING }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: chatWithRole(roleName) }),
    ).toBeVisible();
  });
});
