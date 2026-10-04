// The browser tier's proving journey. Deliberately thin: 001.01 (phase 06) owns the six
// MVP journeys, and most of what they need — sign-in, live activity, a task
// reaching completion — does not exist until 004 and later.
//
// What this does prove, now, is that the tier works end to end: it drives a
// real browser against a real deployment, queries by role and accessible name,
// scans with axe, and reports JUnit XML the way the other five tiers do.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * The identity provider's origin, read from the app's own runtime config
 * before anything navigates away from it. Once a recovery redirect fires
 * there is no longer an app page to read `window.__TCP_CONFIG__` from, so
 * this has to happen first, against a page the app itself served.
 */
const identityProviderOrigin = async (page: Page): Promise<string> => {
  await page.goto('/');
  const config = await page.evaluate(
    () =>
      (window as unknown as { __TCP_CONFIG__: { oidcIssuerUrl: string } })
        .__TCP_CONFIG__,
  );
  return new URL(config.oidcIssuerUrl).origin;
};

test.describe('the application shell', () => {
  test('serves a page with a top-level heading, free of accessibility violations', async ({
    page,
  }) => {
    await page.goto('/');

    // Querying by role and accessible name is the point, not a style choice: a
    // heading that cannot be found this way is one a screen reader cannot
    // describe (ADR-028).
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    const { violations } = await new AxeBuilder({ page }).analyze();

    expect(
      violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} nodes)`),
    ).toEqual([]);
  });
});

/** The four theme/mode combinations ADR-026 defines. */
const THEME_COMBINATIONS: readonly { theme: string; mode: string }[] = [
  { theme: 'default', mode: 'light' },
  { theme: 'default', mode: 'dark' },
  { theme: 'high-contrast', mode: 'light' },
  { theme: 'high-contrast', mode: 'dark' },
];

test.describe('the landing page', () => {
  for (const { theme, mode } of THEME_COMBINATIONS) {
    test(`meets its contrast target in ${theme} ${mode}`, async ({ page }) => {
      await page.addInitScript(
        ([key, choice]) => {
          window.localStorage.setItem(key, choice);
        },
        // 'tcp.theme' is a third copy of THEME_STORAGE_KEY, alongside
        // src/theme/storage.ts and the pre-paint script in index.html — this
        // tier cannot import the source module, so the literal is repeated
        // here deliberately.
        ['tcp.theme', JSON.stringify({ theme, mode })] as const,
      );
      await page.goto('/');

      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(
        violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} nodes)`),
      ).toEqual([]);

      // The default scan above disables nothing, but jsdom's component tier
      // can't run colour-contrast at all, so the browser tier is the only
      // place either contrast rule ever executes. `color-contrast-enhanced`
      // is an axe AAA rule, off by default, so it is requested explicitly for
      // the high-contrast theme; a scan that ran zero checks would otherwise
      // look identical to a clean one, so `passes.length > 0` is asserted
      // alongside the empty violations list.
      const contrastRule =
        theme === 'high-contrast'
          ? 'color-contrast-enhanced'
          : 'color-contrast';
      const contrastScan = await new AxeBuilder({ page })
        .withRules([contrastRule])
        .analyze();

      expect(
        contrastScan.violations.map(
          (v) => `${v.id}: ${v.help} (${v.nodes.length} nodes)`,
        ),
      ).toEqual([]);
      expect(contrastScan.passes.length).toBeGreaterThan(0);
    });
  }

  test('applies and remembers a theme chosen from the page', async ({
    page,
  }) => {
    await page.goto('/');

    // Click the label, not the radio. React Aria's real <input> is visually
    // hidden beneath its <label>, so a pointer aimed at the input hits the
    // label instead and Playwright refuses the click. The component tier never
    // sees this — jsdom's userEvent does no hit-testing — which makes the
    // pointer path something only this tier can actually verify.
    await page
      .locator('label.react-aria-RadioButton')
      .filter({ hasText: 'High contrast' })
      .click();

    await expect(
      page.getByRole('radio', { name: 'High contrast' }),
    ).toBeChecked();
    await expect(page.locator('html')).toHaveAttribute(
      'data-theme',
      'high-contrast',
    );

    // This is the requirement that theme switching be testable somewhere
    // real, proven end to end in a browser rather than jsdom: the choice
    // persists and re-applies itself on a fresh load, not just in memory.
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute(
      'data-theme',
      'high-contrast',
    );
  });

  test('draws the selected and focused options, not just their attributes', async ({
    page,
  }) => {
    await page.goto('/');

    // The component tier can only assert the `data-selected` and
    // `data-focus-visible` attributes, because jsdom returns defaults for
    // `getComputedStyle(el, '::before')` and never expands a shorthand. This
    // is the only tier that sees what is actually drawn — and an unstyled
    // React Aria radio is bare text: nothing marks the chosen option (WCAG
    // 1.4.1) and there is no focus ring (WCAG 2.4.7), with every jsdom test
    // still green.
    const indicator = await page
      .locator('.react-aria-RadioButton[data-selected]')
      .first()
      .evaluate((element) => {
        const before = getComputedStyle(element, '::before');
        return { background: before.backgroundColor, size: before.inlineSize };
      });

    expect(indicator.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(indicator.size).not.toBe('0px');

    // The real radio input is visually hidden, so `:focus-visible` in
    // base.css cannot reach it — the ring has to land on the wrapping label.
    await page.getByRole('button', { name: 'Sign in' }).focus();
    await page.keyboard.press('Tab');

    const outlineWidth = await page
      .locator('.react-aria-RadioButton[data-focus-visible]')
      .first()
      .evaluate((element) => getComputedStyle(element).outlineWidth);

    expect(outlineWidth).not.toBe('0px');
  });
});

// The callback route, from the outside. The component tier intercepts
// `signinCallback()` on the real `UserManager`, so it proves everything above
// the exchange and nothing about how this address behaves when a browser asks
// nginx for it — a route the SPA fallback serves but the router does not know
// renders the not-found page, and would do so silently.
//
// Opened with no authorization parameters, which is the case a person can
// actually reach by hand. The signed-in journey through here is 001.01's (phase 06).
test.describe('the sign-in callback route', () => {
  test('renders its own page, not the not-found page', async ({ page }) => {
    await page.goto('/callback');

    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Signing in',
    );
    // Nothing to retry: there was no sign-in attempt, only an address someone
    // typed. And nothing redirects, which is the property the whole route is
    // built around — a callback that re-attempted sign-in would loop.
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(
      0,
    );
    expect(new URL(page.url()).pathname).toBe('/callback');
  });

  test('has no accessibility violations', async ({ page }) => {
    await page.goto('/callback');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    const { violations } = await new AxeBuilder({ page }).analyze();

    expect(
      violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} nodes)`),
    ).toEqual([]);
  });
});

// The application shell (skip link, header, `main`) renders on every
// signed-in page and on the not-found page. Sign-in exists as of 004.02, so a
// signed-in page IS reachable in a real browser now — but nothing in this tier
// drives it yet, which is 001.01's (phase 06) journey 1. Until then an unknown address is
// still the only shell-bearing route these tests use, and the choice will read
// as odd otherwise.
test.describe('the application shell on an unknown address', () => {
  test('renders a not-found page rather than a blank screen', async ({
    page,
  }) => {
    await page.goto('/no-such-page');

    // hosting.spec.ts deliberately asserts only that nginx served the app
    // document for a deep link; this is the rendering half that prompt left
    // to 003.02.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('moves focus to main when the skip link is used', async ({ page }) => {
    await page.goto('/no-such-page');

    await page.keyboard.press('Tab');

    const skipLink = page.locator('.skip-link');
    await expect(skipLink).toBeFocused();

    // `toBeVisible()` is NOT the assertion to make here, and was the first
    // thing tried: Playwright calls an element visible when it has a non-empty
    // bounding box, and `.skip-link` is clipped to 1×1 rather than hidden — so
    // that assertion passes with `.skip-link:focus` deleted, which is exactly
    // the regression it was meant to catch. Verified by suppressing the rule
    // in the browser and watching it stay green.
    //
    // What has to hold is that focusing it *unclips* it. Both halves matter:
    // `clip-path: none` is the rule having applied at all, and the width is
    // the link being big enough for a sighted keyboard user to read.
    const revealed = await skipLink.evaluate((el) => ({
      clipPath: getComputedStyle(el).clipPath,
      width: el.getBoundingClientRect().width,
    }));
    expect(revealed.clipPath).toBe('none');
    expect(revealed.width).toBeGreaterThan(50);

    await page.keyboard.press('Enter');

    // This is the ONLY tier that can prove this — jsdom does not implement
    // fragment-navigation focus at all, so the component tier can assert the
    // link's target but never that focus arrives.
    const focusedId = await page.evaluate(() => document.activeElement?.id);
    expect(focusedId).toBe('main-content');
  });

  test('has no accessibility violations', async ({ page }) => {
    await page.goto('/no-such-page');

    const { violations } = await new AxeBuilder({ page }).analyze();

    expect(
      violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} nodes)`),
    ).toEqual([]);
  });

  // The announcer's only browser-reachable path, and worth having: react-aria
  // builds its live regions on the first announcement and, outside a test
  // environment, waits 100ms before speaking so the regions have attached.
  // jsdom skips that delay entirely, so the component tier never exercises
  // the code path a real user gets. The announcer primes at import to make
  // the two the same; this is the tier that can tell whether it worked.
  test('carries the announcer, and only the announcer, as a live region', async ({
    page,
  }) => {
    await page.goto('/no-such-page');

    const regions = await page.evaluate(() => ({
      announcers: document.querySelectorAll('[data-live-announcer]').length,
      // Both regions, built empty before anything needed them.
      logs: [...document.querySelectorAll('[data-live-announcer] [role="log"]')]
        .map((el) => el.getAttribute('aria-live'))
        .sort(),
      // 003.02's interim region, which 003.03 replaced rather than joined.
      strays: document.querySelectorAll(
        'p[role="status"], [aria-live]:not([data-live-announcer] *)',
      ).length,
    }));

    expect(regions.announcers).toBe(1);
    expect(regions.logs).toEqual(['assertive', 'polite']);
    expect(regions.strays).toBe(0);
  });

  test('announces the page title on a real route change', async ({ page }) => {
    await page.goto('/no-such-page');

    await page.getByRole('link', { name: 'Go to the landing page' }).click();

    // The announcer appends a node per message rather than mutating one, so
    // the region's text is the announcement itself. Waiting on it also proves
    // the message survives react-aria's first-announcement delay, which is
    // the whole reason this test is in this tier.
    const polite = page.locator('[data-live-announcer] [aria-live="polite"]');
    await expect(polite).toHaveText('TCP');
  });
});

// Reload recovery (004.03) makes a guarded route redirect to the identity
// provider rather than bounce to the landing page. A full sign-in / reload /
// sign-out journey against Zitadel is 001.01's (phase 06); this proves only that the
// recovery redirect really leaves the app, without needing to complete — or
// even attempt — a login.
test.describe('reaching a protected route signed out', () => {
  test('redirects to the identity provider, with no credentials needed', async ({
    page,
  }) => {
    const providerOrigin = await identityProviderOrigin(page);

    await page.goto('/companies');
    await page.waitForURL((url) => url.origin === providerOrigin, {
      timeout: 10_000,
    });

    expect(new URL(page.url()).origin).toBe(providerOrigin);
  });
});

// The one security property of the development sign-in escape hatch, asserted
// against the artefact that actually ships rather than against the source.
//
// `readDevSession` is guarded by `import.meta.env.DEV`, which Vite replaces
// with a literal at build time, so the whole capability should be unreachable
// code the minifier has dropped. That is a claim about a build pipeline, and
// this tier is the only one positioned to check it: the component tier runs
// with `DEV` true by construction and would report the opposite of production.
test.describe('the development session escape hatch', () => {
  test('cannot sign anyone in against a production build', async ({ page }) => {
    const providerOrigin = await identityProviderOrigin(page);

    await page.goto('/companies?devSession=someone');

    // Since 004.03 a guarded route with no session redirects to the identity
    // provider rather than bouncing to the landing page — the destination
    // changed, but the property this test exists to prove did not: a query
    // string still cannot sign anyone in. Leaving for the provider at all is
    // the whole proof, because `RequireSession` only does that having found no
    // session, which is only true if the query string was never read. The
    // Account assertion is a cheap second look that the app never rendered a
    // signed-in header on the way past; it carries little weight once the
    // browser is on the provider's page, and is kept for the case where the
    // redirect regresses and this stays on the app. If this ever fails, anyone
    // who can put a URL in front of a user can walk them past the route guard —
    // treat it as a release blocker, not a flaky test.
    await page.waitForURL((url) => url.origin === providerOrigin, {
      timeout: 10_000,
    });
    await expect(page.getByRole('button', { name: 'Account' })).toHaveCount(0);
  });

  test('leaves no trace of itself in the served bundle', async ({
    page,
    request,
  }) => {
    await page.goto('/');
    const bundleSrc = await page
      .locator('script[type="module"]')
      .first()
      .getAttribute('src');

    const bundle = await (await request.get(bundleSrc ?? '')).text();

    // Stronger than the behavioural check above, and it fails earlier: the
    // parameter name surviving into the bundle means the branch was kept, even
    // if some other condition happens to stop it firing today.
    expect(bundle).not.toContain('devSession');
  });
});
