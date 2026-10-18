import { expect, test } from '@playwright/test';
import { AUTH_STATE_PATH, hasSignInCredentials } from './auth-state';
import { gotoSignedIn } from './signed-in';

/*
 * Literals copied from `strings.ts`, as the other specs do, so a wording
 * change fails here rather than silently testing the wrong control.
 */
const NEW_COMPANY = 'New company';
const USE_BASIC = 'Use the Basic template';
const IMPORT_BASIC = 'Import Basic';
const IMPORT = 'Import company';
const COMPANY_SECTION = 'Company';
const EXPORT = 'Export as template';
const DELETE_COMPANY = 'Delete company';
// The Basic template's planner, from templates/basic/roles/planner/role.json.
const PLANNER_DESCRIPTION = 'Plans each task, then carries out its steps.';

test.use({ storageState: hasSignInCredentials ? AUTH_STATE_PATH : undefined });

test.skip(
  !hasSignInCredentials,
  'Requires TEST_USERNAME/TEST_PASSWORD (the signed-in session) — see ' +
    'scripts/run-browser-tests.sh.',
);

/*
 * Runs as the signed-in person, who becomes the imported company's creator,
 * and deletes the company as its last step, as company.spec.ts does. A
 * failure before that leaves one randomly named company on the testing stack.
 */
test('a company is imported from the gallery, exported, then deleted', async ({
  page,
}) => {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const name = `Template journey ${suffix}`;
  const slug = `template-journey-${suffix}`;

  await gotoSignedIn(page, '/companies');
  await page
    .getByRole('button', { name: NEW_COMPANY, exact: true })
    .first()
    .click();
  await page
    .getByRole('dialog', { name: NEW_COMPANY })
    .getByRole('button', { name: USE_BASIC, exact: true })
    .click();

  const form = page.getByRole('dialog', { name: IMPORT_BASIC });
  await form.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await form.getByRole('textbox', { name: 'Slug', exact: true }).fill(slug);
  await form.getByRole('button', { name: IMPORT, exact: true }).click();

  // Importing lands on the new company, which already has its planner.
  await expect(page).toHaveURL(/\/company\/[^/#]+$/);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await page.goto(`${page.url()}#admin/roles`);
  await expect(page.getByText(PLANNER_DESCRIPTION)).toBeVisible();

  await page
    .getByRole('option', { name: COMPANY_SECTION, exact: true })
    .click();
  const section = page.getByRole('region', { name: COMPANY_SECTION });
  const download = page.waitForEvent('download');
  await section.getByRole('button', { name: EXPORT, exact: true }).click();
  expect((await download).suggestedFilename()).toBe(`${slug}.zip`);

  await section
    .getByRole('button', { name: DELETE_COMPANY, exact: true })
    .click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: DELETE_COMPANY, exact: true })
    .click();
  await expect(page).toHaveURL(/\/companies$/);
  await expect(page.getByRole('link', { name })).toHaveCount(0);
});
