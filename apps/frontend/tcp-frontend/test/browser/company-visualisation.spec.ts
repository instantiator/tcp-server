// The isometric office view (000.01), `CompanyPage`'s default tab. Roles and
// task rooms are real Phaser draws behind a canvas element, so this is the
// one tier that can prove the canvas actually renders — the component tier
// mocks Phaser entirely (see `TcpPhaserVisualisation.test.tsx`). Two credential
// sets are required and neither is optional: the human session to view the
// page, and the machine token to create what it shows, exactly as
// `company-activity.spec.ts` uses for its own fixtures. There is no shared
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
 * Copied from `apps/frontend/tcp-frontend/src/strings.ts`
 * (`visualisation.stage.label`, `company.tab.visualisation`,
 * `visualisation.summary` and `visualisation.keys`). `strings.ts` is app
 * source, not something a browser spec can import, so these are literals —
 * keep them in step by hand if the copy there ever changes.
 */
const OFFICE_VIEW_LABEL = 'Office view';
const COMPANY_VIEW_TAB = 'Company view';
const KEYS_HELP =
  'Use the arrow keys or W, A, S and D to move the view. Double-click an empty space for full screen.';

/*
 * Stage D (000.01) interaction literals, copied the same way from
 * `strings.ts` (`visualisation.pan.right`, `visualisation.fullscreen`,
 * `visualisation.picker.label`, `visualisation.picker.role`,
 * `visualisation.picker.task`, `visualisation.tooltip.role`,
 * `visualisation.tooltip.task`, `visualisation.tray.roleHeading`,
 * `visualisation.tray.taskHeading`, `visualisation.tray.follow` and
 * `visualisation.tray.close`) — keep them in step by hand too.
 */
const PAN_RIGHT_LABEL = 'Scroll right';
const FULLSCREEN_LABEL = 'Full screen';
const SHOW_DETAILS_LABEL = 'Show details for';
const FOLLOW_LABEL = 'Follow';
const CLOSE_DETAILS_LABEL = 'Close details';

/**
 * `visualisation.picker.role`, `visualisation.tray.roleHeading` and
 * `visualisation.tooltip.role` all read the same "Role: {name}" — one helper
 * covers the picker option, the tray heading and the tooltip text.
 */
const roleLabel = (name: string): string => `Role: ${name}`;

/** `visualisation.picker.task`: the picker's own row for a task. */
const taskPickerLabel = (shortcode: string): string => `Task: ${shortcode}`;

/** `visualisation.tray.taskHeading`: the tray's heading for a task — no colon, unlike the picker row above. */
const taskTrayHeading = (shortcode: string): string => `Task ${shortcode}`;

/** `visualisation.tooltip.task`'s title, e.g. "Task 003: (0/0)". */
const taskTooltipProgress = (
  shortcode: string,
  step: number,
  steps: number,
): string => `Task ${shortcode}: (${step}/${steps})`;

/**
 * The first of the two roles `beforeAll` creates below (`roleSuffix` 'a').
 * Its name has no random suffix — only the slug does — so it is stable
 * enough to hardcode here rather than threading it out of `beforeAll`.
 */
const ROLE_A_NAME = 'Visualisation role a';

/**
 * How far above its base tile a role's book takes the pointer, in pixels —
 * `BOOK_ZONE_LIFT` in `AvatarSprite.ts`. A role is drawn as a small book
 * (002.01), so its hit zone sits just above the floor, not over a body.
 */
const ROLE_HOVER_LIFT = 4;

/*
 * 002.01 literals, copied from `strings.ts` the same way
 * (`visualisation.labels.roles`, `visualisation.tray.prompt.expand`).
 */
const ROLES_LABEL_TOGGLE = 'Roles';
const SHOW_FULL_PROMPT_LABEL = 'Show the full prompt';
/** `--tcp-visualisation-height` in `styles/base.css` (32rem at 16px). */
const FIXED_STAGE_HEIGHT_PX = 512;

/*
 * 002.02 stage 8/9 literals, copied the same way from `strings.ts`
 * (`visualisation.picker.archive`, `visualisation.archive.heading`,
 * `visualisation.furniture.bookshelf` and its `.description`,
 * `visualisation.archive.empty` and `visualisation.archive.unconfigured`).
 * The picker option and the tray heading happen to read the same word —
 * they are still two different keys, kept as two constants so a future edit
 * to either doesn't silently desync the other.
 */
const ARCHIVE_PICKER_LABEL = 'Archive';
const ARCHIVE_TRAY_HEADING = 'Archive';
const BOOKSHELF_TITLE = 'Bookshelf';
const BOOKSHELF_DESCRIPTION =
  'Holds the outputs of completed tasks. Select it to see them.';
const ARCHIVE_EMPTY_TEXT = 'No completed tasks yet.';
const ARCHIVE_UNCONFIGURED_TEXT =
  'The storage browser is not configured, so these are shown as text only.';

/**
 * How far above its tile centre the bookshelf's hit zone sits, in pixels —
 * `FURNITURE_SIZES.bookshelf.height / 2` in `scene/drawFurniture.ts`
 * (`height: 34`), the same offset `buildArchiveZone` in
 * `scene/TcpCompanyScene.ts` centres the zone on. Derived the same way the
 * whiteboard test below derives its own `15` from `WHITEBOARD_ZONE_LIFT`,
 * not copied as an unexplained magic number.
 */
const BOOKSHELF_ZONE_LIFT = 17;

/**
 * The visualisation's hidden accessible description, built the way
 * `t('visualisation.summary', …)` and `t('visualisation.keys')` are (000.01
 * Stage D): the stage's `aria-describedby` names both paragraphs, so its
 * accessible description is their text joined with a space.
 */
const summary = (roles: number, taskRooms: number, agents: number): string =>
  `Roles: ${roles}. Task rooms: ${taskRooms}. Agents: ${agents}. ${KEYS_HELP}`;

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

/** The visualisation tab's hidden summary, by its accessible description. */
const officeSummary = (page: Page) =>
  page.getByRole('group', { name: OFFICE_VIEW_LABEL });

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

test.describe('company visualisation', () => {
  let token: string;
  let companyId: string;

  // Real fixtures, not seeded data (ADR-016's black-box posture applied to
  // this tier too): a test that needs a particular row to already exist fails
  // on a fresh deployment for a reason that has nothing to do with the code
  // under test.
  test.beforeAll(async ({ request }) => {
    token = await getMachineToken(request);
    // `fullyParallel` (playwright.config.ts) can run this file's tests in
    // separate worker processes that each call their own `beforeAll` at
    // essentially the same instant, so `Date.now()` alone collides on its
    // own slug (discovered running this spec for 000.01 Stage D) — the
    // random half is what actually makes two workers' suffixes differ.
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    const company = await request.post('/api/company', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: `company-visualisation browser test ${suffix}`,
        slug: `company-visualisation-${suffix}`,
        description: 'Created by company-visualisation.spec.ts',
      },
    });
    expect(company.status()).toBe(201);
    companyId = ((await company.json()) as CreatedCompany).id;

    // Two roles, so the rec room's default summary reads "Roles: 2" rather
    // than the degenerate, easy-to-fake case of one.
    for (const roleSuffix of ['a', 'b']) {
      const role = await request.post('/api/role', {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          companyId,
          slug: `visualisation-role-${roleSuffix}-${suffix}`,
          name: `Visualisation role ${roleSuffix}`,
          description: 'Created by company-visualisation.spec.ts',
          knowledgeDomains: [],
          mcpServerList: [],
        },
      });
      expect(role.status()).toBe(201);
      // The response is only checked for shape here — nothing in this file
      // needs the role's id back.
      void ((await role.json()) as CreatedRole).id;
    }
  });

  test.afterAll(async ({ request }) => {
    // `TcpCompany` cascades its roles and tasks, so nothing else to clean up.
    await request.delete(`/api/company/${companyId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  });

  test('shows the office view by default, with no page errors', async ({
    page,
  }) => {
    const pageErrors: Error[] = [];
    // Attached before `goto`, so a load-time error cannot be missed.
    page.on('pageerror', (err) => {
      pageErrors.push(err);
    });

    await gotoSignedIn(page, `/company/${companyId}`);

    await expect(
      page.getByRole('tab', { name: COMPANY_VIEW_TAB }),
    ).toHaveAttribute('aria-selected', 'true');

    const office = officeSummary(page);
    await expect(office).toBeVisible();
    await expect(office).toHaveAccessibleDescription(summary(2, 0, 0));

    const canvas = office.locator('canvas');
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.width).toBeGreaterThan(0);
    expect(box?.height).toBeGreaterThan(0);

    expect(pageErrors).toEqual([]);
  });

  test('has no accessibility violations on the office view', async ({
    page,
  }) => {
    await gotoSignedIn(page, `/company/${companyId}`);

    await expect(officeSummary(page)).toHaveAccessibleDescription(
      summary(2, 0, 0),
    );

    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations).toEqual([]);
  });

  test("keeps a finished task's room until it is closed from the tray", async ({
    page,
    request,
  }) => {
    // The task is created BEFORE the page opens. Creating a task publishes no
    // live event (docs/prompts/unresolved-notes.md), so an open page would only see a
    // new task once it is started. Removal is the live half tested here.
    const createdTask = await request.post('/api/task', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        companyId,
        request: 'Created by company-visualisation.spec.ts',
      },
    });
    expect(createdTask.status()).toBe(201);
    const { id: taskId, shortcode } = (await createdTask.json()) as CreatedTask;

    await gotoSignedIn(page, `/company/${companyId}`);

    const office = officeSummary(page);
    await expect(office).toHaveAccessibleDescription(summary(2, 1, 0));

    // Driving the change through the real API, not the cache: this is the
    // one test in this file proving the browser receives a live event over an
    // actual connection, the same reasoning `company-activity.spec.ts`'s
    // cancellation test gives for doing the same thing.
    const cancelled = await request.post(`/api/task/${taskId}/cancel`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(cancelled.status()).toBe(202);

    // The room stays once its task has finished, so its outcome can still be
    // seen; the tray says so, and offers to close it.
    await page.getByRole('button', { name: SHOW_DETAILS_LABEL }).click();
    await page
      .getByRole('option', { name: taskPickerLabel(shortcode) })
      .click();
    const tray = page.getByRole('complementary', {
      name: taskTrayHeading(shortcode),
    });
    await expect(tray).toContainText('Cancelled');
    await expect(office).toHaveAccessibleDescription(summary(2, 1, 0));

    await tray.getByRole('button', { name: 'Close room' }).click();

    await expect(office).toHaveAccessibleDescription(summary(2, 0, 0));
  });

  // Stage D (000.01): the toolbar, picker, tooltip, tray, follow and full
  // screen. Every test here emulates reduced motion — avatars jump straight
  // to their targets and follow uses lerp 1 — so a hover or click at a
  // computed screen position lands on an exact, non-animating target.
  test.describe('interaction', () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
    });

    test('a pan button and an arrow key both move the view', async ({
      page,
    }) => {
      await gotoSignedIn(page, `/company/${companyId}`);
      const stage = officeSummary(page);
      const canvas = stage.locator('canvas');
      // Waiting for the snapshot to reach the stage (not just `goto`
      // resolving) also clears a StrictMode-only race: `TcpPhaserVisualisation`
      // mounts twice in dev (its game-mount effect double-invokes), leaving two
      // `<canvas>` elements in the DOM for a few hundred ms before the first
      // one's Phaser instance finishes destroying itself. Asserting on the
      // roles count first, the same way the "shows the office view" test
      // above does, reliably lands after that settles.
      await expect(stage).toHaveAccessibleDescription(summary(2, 0, 0));
      await expect(canvas).toBeVisible();

      const beforePan = await canvas.screenshot();
      await page.getByRole('button', { name: PAN_RIGHT_LABEL }).click();
      // No observable other than the canvas's own pixels changes on a pan,
      // so this polls the screenshot itself rather than a fixed wait.
      await expect
        .poll(async () => Buffer.compare(await canvas.screenshot(), beforePan))
        .not.toBe(0);

      const afterPan = await canvas.screenshot();
      await stage.focus();
      await page.keyboard.press('ArrowDown');
      await expect
        .poll(async () => Buffer.compare(await canvas.screenshot(), afterPan))
        .not.toBe(0);
    });

    // 005.01: pressing on the canvas and dragging ≥ `DRAG_THRESHOLD_PX` (6px)
    // pans the camera and selects nothing; a plain click still selects on
    // pointer *up* (dragPan.ts). This presses over an empty corner rather
    // than an avatar — the same spot the full-screen test below uses to
    // guarantee nothing is hovered — because every other test in this file
    // that needs a deterministic on-screen avatar position gets one via
    // `Follow` first (the camera isn't centred on anything in particular on
    // a fresh load). Starting empty still exercises exactly the code path
    // this guards: `isClick`/`DragPan` don't look at what's under the
    // pointer, only at how far it moved, so a drag that starts empty and one
    // that starts on an avatar take the same branch.
    test('dragging the canvas pans the camera and selects nothing', async ({
      page,
    }) => {
      await gotoSignedIn(page, `/company/${companyId}`);
      const stage = officeSummary(page);
      const canvas = stage.locator('canvas');
      await expect(stage).toHaveAccessibleDescription(summary(2, 0, 0));
      await expect(canvas).toBeVisible();

      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();
      const startX = box!.x + 10;
      const startY = box!.y + 10;

      // "The view moved" is observed the same way the pan-button test above
      // observes it: the canvas has no DOM for its drawn content, so its own
      // pixels are the only thing that can tell a pan happened from a no-op.
      const beforeDrag = await canvas.screenshot();
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      // Well past the 6px threshold, and in several `steps` so Phaser's
      // pointer sees a stream of moves rather than one jump — the same shape
      // a real drag arrives in.
      await page.mouse.move(startX + 80, startY + 60, { steps: 10 });
      await page.mouse.up();

      // "Selects nothing": a drag this long starting on empty space would
      // never have selected anything anyway, so the meaningful half of this
      // assertion is that *no* tray exists at all — proving the drag didn't
      // fall through to a click handler that selected whatever was under the
      // pointer at mouse-up.
      await expect(page.getByRole('complementary')).toHaveCount(0);
      await expect
        .poll(async () => Buffer.compare(await canvas.screenshot(), beforeDrag))
        .not.toBe(0);
    });

    test('a role tray overlays the stage without resizing the canvas, follows, hovers and closes', async ({
      page,
    }) => {
      await gotoSignedIn(page, `/company/${companyId}`);
      const stage = officeSummary(page);
      const canvas = stage.locator('canvas');
      // See the pan test above for why this goes first: it also clears the
      // dev-only StrictMode double-mount race before anything else touches
      // the canvas.
      await expect(stage).toHaveAccessibleDescription(summary(2, 0, 0));

      const beforeOpen = await canvas.boundingBox();
      expect(beforeOpen).not.toBeNull();

      await page.getByRole('button', { name: SHOW_DETAILS_LABEL }).click();
      await page.getByRole('option', { name: roleLabel(ROLE_A_NAME) }).click();

      const tray = page.getByRole('complementary', {
        name: roleLabel(ROLE_A_NAME),
      });
      await expect(tray).toBeVisible();

      // 005.01: the tray is now an absolutely-positioned overlay on the
      // stage's right edge rather than a flex sibling sharing `__main`'s row
      // with the canvas, so opening it must leave the canvas's own size
      // alone (the old layout narrowed it to make room) — and the tray's own
      // box should sit flush against the canvas's right edge, not beside it.
      const openBox = await canvas.boundingBox();
      expect(openBox).not.toBeNull();
      expect(openBox!.width).toBeCloseTo(beforeOpen!.width, 0);
      const trayBox = await tray.boundingBox();
      expect(trayBox).not.toBeNull();
      expect(trayBox!.x + trayBox!.width).toBeCloseTo(
        openBox!.x + openBox!.width,
        0,
      );

      const followButton = page.getByRole('button', { name: FOLLOW_LABEL });
      await followButton.click();
      await expect(followButton).toHaveAttribute('aria-pressed', 'true');

      const cx = openBox!.x + openBox!.width / 2;
      const cy = openBox!.y + openBox!.height / 2;

      // Follow centres the camera on the role's base tile, so the canvas's
      // own centre, lifted onto the book, is where the pointer meets it.
      await page.mouse.move(cx, cy - ROLE_HOVER_LIFT);
      await expect(page.getByRole('tooltip')).toHaveText(
        roleLabel(ROLE_A_NAME),
      );
      await expect(canvas).toHaveCSS('cursor', 'pointer');

      // Clicking the same, still-centred spot re-selects the same role —
      // the pointer route to a selection that's already open.
      await page.mouse.click(cx, cy - ROLE_HOVER_LIFT);
      await expect(tray).toBeVisible();

      await page.getByRole('button', { name: CLOSE_DETAILS_LABEL }).click();
      await expect(tray).toBeHidden();
      await expect(stage).toBeFocused();

      // Closing the tray no longer widens the canvas either (005.01: it was
      // never narrowed to begin with) — the camera and the canvas box are
      // both exactly where they were, so the same screen position still
      // lands on the avatar.
      const closedBox = await canvas.boundingBox();
      expect(closedBox).not.toBeNull();
      expect(closedBox!.width).toBeCloseTo(beforeOpen!.width, 0);
      await page.mouse.click(cx, cy - ROLE_HOVER_LIFT);
      await expect(tray).toBeVisible();
    });

    test('a task tray follows the whiteboard and passes axe while open', async ({
      page,
      request,
    }) => {
      // Created before `goto`, same as the task-room test above: creating a
      // task publishes no live event (docs/prompts/unresolved-notes.md).
      const createdTask = await request.post('/api/task', {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          companyId,
          request: 'Created by company-visualisation.spec.ts',
        },
      });
      expect(createdTask.status()).toBe(201);
      const { id: taskId, shortcode } =
        (await createdTask.json()) as CreatedTask;

      await gotoSignedIn(page, `/company/${companyId}`);
      const stage = officeSummary(page);
      const canvas = stage.locator('canvas');
      // See the pan test above for why this goes first (the dev-only
      // StrictMode double-mount race). One task room is already up.
      await expect(stage).toHaveAccessibleDescription(summary(2, 1, 0));

      await page.getByRole('button', { name: SHOW_DETAILS_LABEL }).click();
      await page
        .getByRole('option', { name: taskPickerLabel(shortcode) })
        .click();

      const tray = page.getByRole('complementary', {
        name: taskTrayHeading(shortcode),
      });
      await expect(tray).toBeVisible();
      await expect(tray).toContainText(
        'Created by company-visualisation.spec.ts',
      );

      await page.getByRole('button', { name: FOLLOW_LABEL }).click();

      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();
      const cx = box!.x + box!.width / 2;
      const cy = box!.y + box!.height / 2;

      // Follow centres the camera on the whiteboard's tile centre, so the
      // canvas's own centre — 15px up (TcpCompanyScene's whiteboard zone
      // lift) — is where the pointer meets it.
      await page.mouse.move(cx, cy - 15);
      const tooltip = page.getByRole('tooltip');
      await expect(tooltip).toContainText(taskTooltipProgress(shortcode, 0, 0));
      await expect(tooltip).toContainText(
        'Created by company-visualisation.spec.ts',
      );

      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(violations).toEqual([]);

      const cancelled = await request.post(`/api/task/${taskId}/cancel`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(cancelled.status()).toBe(202);
    });

    test('full screen toggles on an empty corner but not on an avatar', async ({
      page,
    }) => {
      await gotoSignedIn(page, `/company/${companyId}`);
      const stage = officeSummary(page);
      const canvas = stage.locator('canvas');
      // See the pan test above for why this goes first (the dev-only
      // StrictMode double-mount race).
      await expect(stage).toHaveAccessibleDescription(summary(2, 0, 0));
      await expect(canvas).toBeVisible();

      const fullscreenToggle = page.getByRole('button', {
        name: FULLSCREEN_LABEL,
      });
      // Guards a real bug just fixed (000.01 plan, "Discovered during
      // implementation"): `useFullscreen` used to read as pressed on its
      // very first render.
      await expect(fullscreenToggle).toHaveAttribute('aria-pressed', 'false');

      const corner = await canvas.boundingBox();
      expect(corner).not.toBeNull();

      // An empty corner: nothing is hovered, so the stage's own double-click
      // handler requests full screen (`CompanyVisualisation.onStageDoubleClick`).
      await page.mouse.dblclick(corner!.x + 10, corner!.y + 10);
      await expect
        .poll(() => page.evaluate(() => document.fullscreenElement !== null))
        .toBe(true);
      await expect(fullscreenToggle).toHaveAttribute('aria-pressed', 'true');

      await fullscreenToggle.click();
      await expect
        .poll(() => page.evaluate(() => document.fullscreenElement !== null))
        .toBe(false);
      await expect(fullscreenToggle).toHaveAttribute('aria-pressed', 'false');

      // Double-clicking ON an avatar must not enter full screen: the stage
      // sees a hover at the time of the click and skips the toggle.
      await page.getByRole('button', { name: SHOW_DETAILS_LABEL }).click();
      await page.getByRole('option', { name: roleLabel(ROLE_A_NAME) }).click();
      await page.getByRole('button', { name: FOLLOW_LABEL }).click();

      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();
      const cx = box!.x + box!.width / 2;
      const cy = box!.y + box!.height / 2;

      await page.mouse.move(cx, cy - ROLE_HOVER_LIFT);
      // Confirms the hover state has actually landed before the double-click
      // races it — there is no other observable for "hover is now set".
      await expect(page.getByRole('tooltip')).toBeVisible();
      await page.mouse.dblclick(cx, cy - ROLE_HOVER_LIFT);

      // Asserting a negative has no observable to poll for, so this is a
      // short, commented wait rather than `expect.poll`: long enough for a
      // `fullscreenchange` to have fired if one was going to.
      await page.waitForTimeout(500);
      expect(
        await page.evaluate(() => document.fullscreenElement !== null),
      ).toBe(false);
    });

    test('the Roles label toggle draws and clears labels on the canvas', async ({
      page,
    }) => {
      await gotoSignedIn(page, `/company/${companyId}`);
      const stage = officeSummary(page);
      const canvas = stage.locator('canvas');
      // See the pan test above for why this goes first.
      await expect(stage).toHaveAccessibleDescription(summary(2, 0, 0));
      await expect(canvas).toBeVisible();

      const toggle = page.getByRole('checkbox', { name: ROLES_LABEL_TOGGLE });
      const unlabelled = await canvas.screenshot();

      // By keyboard: React Aria's label sits over the visually hidden input,
      // so Playwright's `check()` can't click the input itself.
      await toggle.focus();
      await page.keyboard.press('Space');
      await expect(toggle).toBeChecked();
      // The labels are canvas pixels, with no DOM of their own to query.
      await expect
        .poll(async () => Buffer.compare(await canvas.screenshot(), unlabelled))
        .not.toBe(0);

      // Not compared with the unlabelled shot: the canvas is not guaranteed
      // to repaint pixel-for-pixel, so this checks the labels went away.
      const labelled = await canvas.screenshot();
      await page.keyboard.press('Space');
      await expect(toggle).not.toBeChecked();
      await expect
        .poll(async () => Buffer.compare(await canvas.screenshot(), labelled))
        .not.toBe(0);
    });

    test('the stage fills the window below it, never shorter than its fixed height', async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 1400 });
      await gotoSignedIn(page, `/company/${companyId}`);
      const stage = officeSummary(page);
      await expect(stage).toHaveAccessibleDescription(summary(2, 0, 0));

      // A tall window: the stage reaches (almost) to its bottom edge.
      await expect
        .poll(() =>
          stage.evaluate(
            (element) =>
              window.innerHeight - element.getBoundingClientRect().bottom,
          ),
        )
        .toBeLessThan(32);

      // And the canvas fills the stage. Phaser sized it once at boot, before
      // the stage had grown, and stayed at the fixed height (005.01); the
      // stage's own size alone never showed it.
      const canvasHeight = () =>
        stage
          .locator('canvas')
          .evaluate((element) => element.getBoundingClientRect().height);
      const stageHeight = async () => (await stage.boundingBox())?.height ?? 0;
      await expect
        .poll(async () =>
          Math.abs((await stageHeight()) - (await canvasHeight())),
        )
        .toBeLessThan(2);

      // A short window: the fixed height is the floor, and the page scrolls.
      await page.setViewportSize({ width: 1280, height: 400 });
      await expect
        .poll(async () => (await stage.boundingBox())?.height)
        .toBeGreaterThanOrEqual(FIXED_STAGE_HEIGHT_PX);
    });

    test("a long task request is clipped in the tray, with a '…' that reveals it", async ({
      page,
      request,
    }) => {
      const longRequest =
        'Created by company-visualisation.spec.ts to check clipping: reconcile every account in the ledger against the bank statements, tracing each discrepancy to its journal entry, and write it all up.';
      const createdTask = await request.post('/api/task', {
        headers: { Authorization: `Bearer ${token}` },
        data: { companyId, request: longRequest },
      });
      expect(createdTask.status()).toBe(201);
      const { id: taskId, shortcode } =
        (await createdTask.json()) as CreatedTask;

      await gotoSignedIn(page, `/company/${companyId}`);
      const stage = officeSummary(page);
      await expect(stage).toHaveAccessibleDescription(summary(2, 1, 0));

      await page.getByRole('button', { name: SHOW_DETAILS_LABEL }).click();
      await page
        .getByRole('option', { name: taskPickerLabel(shortcode) })
        .click();
      const tray = page.getByRole('complementary', {
        name: taskTrayHeading(shortcode),
      });
      await expect(tray).not.toContainText(longRequest);

      await tray.getByRole('button', { name: SHOW_FULL_PROMPT_LABEL }).click();
      await expect(tray).toContainText(longRequest);

      const cancelled = await request.post(`/api/task/${taskId}/cancel`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(cancelled.status()).toBe(202);
    });

    // 002.02 stage 8/9: the archive room and its bookshelf. There is no
    // succeeded-task fixture here — see the note above `describe('company
    // visualisation')` for why driving a task to `succeeded` needs a real
    // LLM turn this tier cannot supply. The empty state still proves the
    // tray opens from both routes and reads its live config correctly.
    test('an archive tray opens from the picker and the bookshelf, with a tooltip', async ({
      page,
    }) => {
      await gotoSignedIn(page, `/company/${companyId}`);
      const stage = officeSummary(page);
      const canvas = stage.locator('canvas');
      // See the pan test above for why this goes first (the dev-only
      // StrictMode double-mount race).
      await expect(stage).toHaveAccessibleDescription(summary(2, 0, 0));

      const beforeOpen = await canvas.boundingBox();
      expect(beforeOpen).not.toBeNull();

      await page.getByRole('button', { name: SHOW_DETAILS_LABEL }).click();
      await page.getByRole('option', { name: ARCHIVE_PICKER_LABEL }).click();

      const tray = page.getByRole('complementary', {
        name: ARCHIVE_TRAY_HEADING,
      });
      await expect(tray).toBeVisible();
      // No succeeded task exists for this company, so the tray reads its
      // empty state. The absence of the "not configured" note is the
      // positive half of that check: it proves `MINIO_CONSOLE_URL` and
      // `MINIO_BUCKET_PREFIX` (docker-compose.yml's `tcp-web`) actually
      // reached this deployment's runtime config — a succeeded row would
      // otherwise render as plain text instead of a Silo link.
      await expect(tray).toContainText(ARCHIVE_EMPTY_TEXT);
      await expect(tray).not.toContainText(ARCHIVE_UNCONFIGURED_TEXT);

      // 005.01: the tray overlays the stage's right edge now, rather than
      // sharing a row with the canvas, so opening it leaves the canvas's own
      // size alone — and the tray's box sits flush against the canvas's
      // right edge, same check the role tray test above makes.
      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeCloseTo(beforeOpen!.width, 0);
      const trayBox = await tray.boundingBox();
      expect(trayBox).not.toBeNull();
      expect(trayBox!.x + trayBox!.width).toBeCloseTo(box!.x + box!.width, 0);

      await page.getByRole('button', { name: FOLLOW_LABEL }).click();

      const cx = box!.x + box!.width / 2;
      const cy = box!.y + box!.height / 2;

      // Follow centres the camera on the bookshelf's tile centre, so the
      // canvas's own centre, lifted onto the bookshelf's hit zone, is where
      // the pointer meets it — the same derivation the whiteboard test above
      // gives its own `15`.
      await page.mouse.move(cx, cy - BOOKSHELF_ZONE_LIFT);
      const tooltip = page.getByRole('tooltip');
      await expect(tooltip).toContainText(BOOKSHELF_TITLE);
      await expect(tooltip).toContainText(BOOKSHELF_DESCRIPTION);

      await page.getByRole('button', { name: CLOSE_DETAILS_LABEL }).click();
      await expect(tray).toBeHidden();

      // Closing no longer widens the canvas either (005.01: it was never
      // narrowed to begin with), so the same screen position still lands on
      // the bookshelf with no need to recompute its box.
      const closedBox = await canvas.boundingBox();
      expect(closedBox).not.toBeNull();
      expect(closedBox!.width).toBeCloseTo(beforeOpen!.width, 0);

      // The second way in: clicking the bookshelf directly, with no picker.
      await page.mouse.click(cx, cy - BOOKSHELF_ZONE_LIFT);
      await expect(tray).toBeVisible();
    });
  });
});
