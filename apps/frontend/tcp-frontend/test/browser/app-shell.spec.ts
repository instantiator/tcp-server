// The browser tier's proving journey. Deliberately thin: 009.01 owns the six
// MVP journeys, and most of what they need — sign-in, live activity, a task
// reaching completion — does not exist until 004 and later.
//
// What this does prove, now, is that the tier works end to end: it drives a
// real browser against a real deployment, queries by role and accessible name,
// scans with axe, and reports JUnit XML the way the other five tiers do.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

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
