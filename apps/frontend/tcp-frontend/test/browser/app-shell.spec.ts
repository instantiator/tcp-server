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
