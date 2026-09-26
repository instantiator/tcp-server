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

/**
 * A task row's accessible name (008.03): the button that opens its dialog,
 * copied from `activity.tasks.open` in `strings.ts` by hand for the same
 * reason the headings above are — keep it in step if the copy there changes.
 */
const taskRowName = (shortcode: string) => `Open task ${shortcode}`;

/**
 * Navigates to a company and switches to the activity tab — the
 * visualisation tab is first in the list and is selected by default, so
 * every test in this file needs this rather than a bare `page.goto`.
 * `'Activity'` is `company.tab.activity` from `strings.ts`, copied by hand
 * for the same reason the headings above are.
 */
const gotoCompanyActivity = async (
  page: Page,
  companyId: string,
): Promise<void> => {
  await page.goto(`/company/${companyId}`);
  await page.getByRole('tab', { name: 'Activity' }).click();
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

  test('renders all four activity lists as labelled regions', async ({
    page,
  }) => {
    await gotoCompanyActivity(page, companyId);
    await expect(
      page.getByRole('heading', { level: 1, name: companyName }),
    ).toBeVisible();

    // By role and accessible name (ADR-028), the same contract
    // `ActivityList` promises in the component tier — this is that promise
    // checked against a real browser's accessibility tree rather than
    // jsdom's approximation of one.
    for (const heading of [
      AGENTS_HEADING,
      TASKS_HEADING,
      CONSULTATIONS_HEADING,
      ENQUIRIES_HEADING,
    ]) {
      await expect(page.getByRole('region', { name: heading })).toBeVisible();
    }
  });

  test('has no accessibility violations on the activity view', async ({
    page,
  }) => {
    await gotoCompanyActivity(page, companyId);
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

    await gotoCompanyActivity(page, companyId);

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
    await gotoCompanyActivity(page, companyId);

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
});
