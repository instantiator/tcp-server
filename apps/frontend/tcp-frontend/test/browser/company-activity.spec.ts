// The live activity view (007.02), the first page this tier reaches that
// both requires a signed-in session (007.03) AND needs its own data — the
// company overview and shell tests before it needed neither. Two credential
// sets are therefore required and neither is optional: the human session to
// view the page, and the machine token to create what it shows, exactly as
// `event-streams.spec.ts` uses for its own fixtures. There is no shared
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
import { gotoSignedIn } from './signed-in';

const OIDC_DISCOVERY_URL =
  process.env.OIDC_DISCOVERY_URL ??
  'http://localhost:8080/.well-known/openid-configuration';
const TEST_CLIENT_ID = process.env.TEST_CLIENT_ID ?? '';
const TEST_CLIENT_SECRET = process.env.TEST_CLIENT_SECRET ?? '';
const hasMachineCredentials = Boolean(TEST_CLIENT_ID && TEST_CLIENT_SECRET);

/*
 * The four activity lists' accessible names, copied from
 * `apps/frontend/tcp-frontend/src/strings.ts` (`activity.agents.heading`,
 * `activity.tasks.heading`, `activity.consultations.heading`,
 * `activity.enquiries.heading`). `strings.ts` is app source, not something a
 * browser spec can import, so these are literals — keep them in step by hand
 * if the copy there ever changes.
 */
const AGENTS_HEADING = 'Active agents';
const TASKS_HEADING = 'Tasks';
const CONSULTATIONS_HEADING = 'Consultations';
const ENQUIRIES_HEADING = 'Enquiries';
/** `activity.chats.heading` — the fifth list, added 002.02 stage 7/9. */
const CHATS_HEADING = 'Chats';

/**
 * A task row's accessible name (008.03): the button that opens its dialog,
 * copied from `activity.tasks.open` in `strings.ts` by hand for the same
 * reason the headings above are — keep it in step if the copy there changes.
 */
const taskRowName = (shortcode: string) => `Open task ${shortcode}`;

/*
 * 002.02 stage 7 literals, copied the same way from `strings.ts`
 * (`activity.chats.open`, `chat.dialog.heading`, `chat.conversation.label`,
 * `dialog.minimise`, `dialog.close`; the chat dialog docks as one entry named
 * by its heading since 000.06).
 * `POST /api/agent/chat/start` creates an orphan assignment
 * (`AgentDbService.create`) with no shortcode — only a task's plan,
 * implement, QA and finalise assignments get one, from
 * `buildAssignmentShortcode` — so `ChatsList.tsx` passes `reference: null`
 * for this fixture, and the panel heading carries no reference suffix.
 */
const chatRowName = (role: string) => `Open the chat with ${role}`;
const chatPanelHeading = (role: string) => `Chat with ${role}`;
const CHAT_DIALOG_HEADING = 'Chats';
const MINIMISE_LABEL = 'Minimise';
const CLOSE_LABEL = 'Close';
/** `dock.label`: the bar minimised dialogs sit in. */
const DOCK_LABEL = 'Minimised dialogs';

/** `activity.filter.label`: the tasks list's status checkbox group. */
const TASK_STATUSES_FILTER_LABEL = 'Task statuses';
/** `activity.status.succeeded`, via `statusLabel` in `api/statuses.ts`. */
const SUCCEEDED_STATUS_LABEL = 'Succeeded';

/**
 * Navigates straight to a company's Tasks tab via its URL hash (005.01: the
 * single "Activity" tab is gone — there is now one tab per activity list,
 * selected by `#agents`/`#tasks`/`#consultations`/`#enquiries`/`#chats`, and
 * the visualisation tab, selected by default, is first in the list). Most of
 * this file's tests live under Tasks or Chats, so this is the shared
 * default; a test that needs a different tab navigates to its own hash
 * directly instead (see the deep-link test below).
 */
const gotoCompanyTasks = async (
  page: Page,
  companyId: string,
): Promise<void> => {
  await gotoSignedIn(page, `/company/${companyId}#tasks`);
};

interface TokenEndpoint {
  token_endpoint: string;
}

interface TokenResponse {
  access_token: string;
}

interface CreatedCompany {
  id: string;
}

interface CreatedTask {
  id: string;
  shortcode: string;
}

interface CreatedRole {
  id: string;
}

interface CreatedAgent {
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

test.describe('company activity', () => {
  let token: string;
  let companyId: string;
  let companyName: string;
  let taskId: string;
  let taskShortcode: string;

  // Real fixtures, not seeded data (ADR-016's black-box posture applied to
  // this tier too): a test that needs a particular row to already exist fails
  // on a fresh deployment for a reason that has nothing to do with the code
  // under test.
  test.beforeAll(async ({ request }) => {
    token = await getMachineToken(request);
    // `fullyParallel` runs this hook once per test, often in the same
    // millisecond on different workers, so a timestamp alone collides on the
    // slug's unique constraint (a 500). The random half keeps them apart.
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    companyName = `company-activity browser test ${suffix}`;

    const company = await request.post('/api/company', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: companyName,
        slug: `company-activity-${suffix}`,
        description: 'Created by company-activity.spec.ts',
      },
    });
    expect(company.status()).toBe(201);
    companyId = ((await company.json()) as CreatedCompany).id;

    // `ready` by construction (no plan is generated until `POST
    // .../start`) — squarely inside `ACTIVE_TASK_STATUSES`, so it renders in
    // the tasks list's default filter with no extra setup.
    const createdTask = await request.post('/api/task', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        companyId,
        request: 'Created by company-activity.spec.ts',
      },
    });
    expect(createdTask.status()).toBe(201);
    const taskBody = (await createdTask.json()) as CreatedTask;
    taskId = taskBody.id;
    taskShortcode = taskBody.shortcode;
  });

  test.afterAll(async ({ request }) => {
    // `TcpTask.company` is `onDelete: 'CASCADE'`, so the task fixture goes
    // with it — nothing else to clean up here.
    await request.delete(`/api/company/${companyId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  });

  test('renders each activity list as a labelled region behind its own tab', async ({
    page,
  }) => {
    await gotoSignedIn(page, `/company/${companyId}`);
    await expect(
      page.getByRole('heading', { level: 1, name: companyName }),
    ).toBeVisible();

    // 005.01: the single "Activity" tab is gone — each list is now its own
    // tab, selected one at a time, so this walks all four rather than
    // checking them simultaneously. By role and accessible name (ADR-028),
    // the same contract `ActivityList` promises in the component tier — this
    // is that promise checked against a real browser's accessibility tree
    // rather than jsdom's approximation of one. The tab's own name gets a
    // trailing count badge once its list loads, so it is matched by a regex
    // anchored at the start rather than an exact string.
    for (const heading of [
      AGENTS_HEADING,
      TASKS_HEADING,
      CONSULTATIONS_HEADING,
      ENQUIRIES_HEADING,
    ]) {
      await page.getByRole('tab', { name: new RegExp(`^${heading}`) }).click();
      await expect(page.getByRole('region', { name: heading })).toBeVisible();
    }
  });

  test('has no accessibility violations on the activity view', async ({
    page,
  }) => {
    await gotoCompanyTasks(page, companyId);
    // Waiting for the fixture row, not just the region: a scan that ran
    // against the loading skeleton would miss whatever the populated rows
    // themselves introduce.
    await expect(
      page
        .getByRole('region', { name: TASKS_HEADING })
        .getByRole('button', { name: taskRowName(taskShortcode) }),
    ).toBeVisible();

    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations).toEqual([]);
  });

  test('opens exactly one event stream for the whole view', async ({
    page,
  }) => {
    // `openStreamCount` (src/events/subscriptions.ts) is what the component
    // tier reads directly, but it is a plain module-internal export with
    // nothing wiring it onto `window` — unreachable from a page context in a
    // production build, which is what this tier drives. So this counts the
    // browser's own requests to the event-stream endpoints instead: the one
    // thing observable from outside the bundle that stands in for "how many
    // subscriptions are open". The listener is attached before `goto` so the
    // very first request cannot be missed.
    const eventStreamPath = /^\/api\/(?:company|task|agent)\/[^/]+\/events$/;
    const streamRequests: string[] = [];
    page.on('request', (req) => {
      if (eventStreamPath.test(new URL(req.url()).pathname)) {
        streamRequests.push(req.url());
      }
    });

    await gotoCompanyTasks(page, companyId);

    // The fixture row is the signal that the whole view — every list's own
    // query, not just the shell — has settled, which is as long as
    // `CompanyPage`'s one `useEventStream` call ever gets to open its
    // connection on a normal load with nothing retrying.
    await expect(
      page
        .getByRole('region', { name: TASKS_HEADING })
        .getByRole('button', { name: taskRowName(taskShortcode) }),
    ).toBeVisible();

    // Exactly one, not "at least one": ADR-030 states `CompanyActivity`'s
    // four lists read the cache `CompanyPage`'s own subscription patches,
    // they do not open one each, and a fan-out here is the specific
    // regression `MAX_STREAMS` exists to catch loudly elsewhere.
    expect(streamRequests).toHaveLength(1);
  });

  test('reflects a live task cancellation, with no reload', async ({
    page,
    request,
  }) => {
    await gotoCompanyTasks(page, companyId);

    const taskRow = page
      .getByRole('region', { name: TASKS_HEADING })
      .getByRole('button', { name: taskRowName(taskShortcode) });
    await expect(taskRow).toBeVisible();

    // Driving the change through the real API, not the cache: this is the
    // one test in this tier proving the browser receives a live event over
    // an actual connection. The component tier already proves `applyEvent`
    // patches the query cache correctly (`CompanyActivity.test.tsx`); it
    // cannot prove the wire itself works.
    const cancelled = await request.post(`/api/task/${taskId}/cancel`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(cancelled.status()).toBe(202);

    // The tasks list's default filter is `ACTIVE_TASK_STATUSES`
    // (ready/planning/in-progress/finalising) — `cancelled` isn't one of
    // them, so the row leaving the DOM (not just its status text changing)
    // is the visible effect of the event arriving. Playwright's own
    // auto-waiting, not a sleep: this polls until the row is gone or the
    // test's own timeout is reached.
    await expect(taskRow).toBeHidden();
  });

  // 005.01: activity panels stay mounted while hidden (`shouldForceMount`),
  // which is what lets a list's filter survive the user switching away and
  // back — no filter state is lifted out of the lists into `CompanyTabs`.
  test('a filter survives switching away to another tab and back', async ({
    page,
  }) => {
    await gotoCompanyTasks(page, companyId);
    const filterGroup = page
      .getByRole('region', { name: TASKS_HEADING })
      .getByRole('group', { name: TASK_STATUSES_FILTER_LABEL });
    // `Succeeded` is off by default (`ACTIVE_TASK_STATUSES` is
    // ready/planning/in-progress/finalising), so checking it is an
    // unambiguous, deliberate change rather than un-checking one of the
    // defaults. React Aria's label sits over the visually hidden input
    // (`base.css`), so this focuses it and toggles by keyboard, the same way
    // `company-visualisation.spec.ts`'s Roles toggle test does.
    const succeededCheckbox = filterGroup.getByRole('checkbox', {
      name: SUCCEEDED_STATUS_LABEL,
    });
    await succeededCheckbox.focus();
    await page.keyboard.press('Space');
    await expect(succeededCheckbox).toBeChecked();

    await page.getByRole('tab', { name: CHATS_HEADING }).click();
    await expect(
      page.getByRole('region', { name: CHATS_HEADING }),
    ).toBeVisible();

    await page
      .getByRole('tab', { name: new RegExp(`^${TASKS_HEADING}`) })
      .click();
    await expect(succeededCheckbox).toBeChecked();
  });

  // 005.01: the selected tab is the URL hash, so a notification link (or any
  // other deep link) that names a tab opens straight onto it, and switching
  // tabs keeps the address bar in step rather than leaving it pointing at a
  // tab that isn't shown any more.
  test('a hash deep-links to a tab, and switching tabs updates the hash', async ({
    page,
  }) => {
    await gotoSignedIn(page, `/company/${companyId}#enquiries`);
    await expect(
      page.getByRole('tab', { name: new RegExp(`^${ENQUIRIES_HEADING}`) }),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(
      page.getByRole('region', { name: ENQUIRIES_HEADING }),
    ).toBeVisible();

    await gotoSignedIn(page, `/company/${companyId}#tasks`);
    await expect(
      page.getByRole('tab', { name: new RegExp(`^${TASKS_HEADING}`) }),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(
      page.getByRole('region', { name: TASKS_HEADING }),
    ).toBeVisible();

    // Selecting a tab replaces the history entry with its own hash
    // (`CompanyTabs`'s `onSelectionChange`) rather than leaving the URL
    // behind — this is the write half of the same contract the reads above
    // check.
    await page
      .getByRole('tab', { name: new RegExp(`^${CONSULTATIONS_HEADING}`) })
      .click();
    await expect(page).toHaveURL(/#consultations$/);
  });

  test('shows "TCP: <company name>" in the header on the company page', async ({
    page,
  }) => {
    await gotoSignedIn(page, `/company/${companyId}`);
    // `app.titleWithCompany` from `strings.ts` — a plain `<span>` inside the
    // page's `<header>` (`app-header__logo`), not its own landmark or
    // heading, so this is scoped to the banner rather than queried by role.
    await expect(
      page.getByRole('banner').getByText(`TCP: ${companyName}`),
    ).toBeVisible();
  });

  // 002.02 stage 7/11: minimise, restore, close and reopen a chat.
  //
  // Fixture: `POST /api/agent/chat/start` creates the chat's agent and its
  // `in-progress` assignment (`AgentDbService.create`) with no LLM turn — a
  // turn only runs once `POST /api/agent/:id/message` is called
  // (`api.agent.controller.ts`'s own doc comment on `startChat`/`sendMessage`
  // says so directly). A task's plan/implement/QA/finalise stages, by
  // contrast, each dispatch a live agent job the moment they're created
  // (`TaskOrchestrationService.dispatchAgentFor`), which is why this file's
  // task fixture never drives a task past `ready` — this spec deliberately
  // never sends a message, so the agent stays `idle` throughout and its dock
  // label is stable.
  test('minimises, restores, closes and reopens a chat from Activity → Chats', async ({
    page,
    request,
  }) => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const roleName = `Chat role ${suffix}`;
    const role = await request.post('/api/role', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        companyId,
        slug: `chat-role-${suffix}`,
        name: roleName,
        description: 'Created by company-activity.spec.ts',
        knowledgeDomains: [],
        mcpServerList: [],
      },
    });
    expect(role.status()).toBe(201);
    const roleId = ((await role.json()) as CreatedRole).id;

    const chatAgent = await request.post('/api/agent/chat/start', {
      headers: { Authorization: `Bearer ${token}` },
      data: { companyId, roleId },
    });
    expect(chatAgent.status()).toBe(201);
    void ((await chatAgent.json()) as CreatedAgent).id;

    // Straight to the Chats tab: this fixture's agent lives there, not under
    // Tasks, so `gotoCompanyTasks` would not do.
    await gotoSignedIn(page, `/company/${companyId}#chats`);
    const chatRow = page
      .getByRole('region', { name: CHATS_HEADING })
      .getByRole('button', { name: chatRowName(roleName) });
    await expect(chatRow).toBeVisible();
    await chatRow.click();

    const dialog = page.getByRole('dialog', { name: CHAT_DIALOG_HEADING });
    const panel = page.getByRole('heading', {
      level: 3,
      name: chatPanelHeading(roleName),
    });
    await expect(dialog).toBeVisible();
    await expect(panel).toBeVisible();

    // Minimise: the dialog unmounts and a dock entry takes its place.
    await page.getByRole('button', { name: MINIMISE_LABEL }).click();
    await expect(dialog).toBeHidden();
    const dockButton = page
      .getByRole('navigation', { name: DOCK_LABEL })
      .getByRole('button', { name: CHAT_DIALOG_HEADING });
    await expect(dockButton).toBeVisible();

    // Restore: the dock entry is gone, the dialog and panel are back.
    await dockButton.click();
    await expect(dialog).toBeVisible();
    await expect(panel).toBeVisible();
    await expect(dockButton).toBeHidden();

    // Close: the dialog's own Close (000.06). Nothing is docked.
    await dialog
      .getByRole('button', { name: CLOSE_LABEL, exact: true })
      .click();
    await expect(dialog).toBeHidden();
    await expect(dockButton).toBeHidden();

    // Closing leaves the chat on the server, so Activity → Chats is still
    // the way back in.
    await expect(chatRow).toBeVisible();
    await chatRow.click();
    await expect(dialog).toBeVisible();
    await expect(panel).toBeVisible();
  });
});
