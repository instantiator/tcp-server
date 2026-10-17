import { expect, test } from '@playwright/test';
import { AUTH_STATE_PATH, hasSignInCredentials } from './auth-state';
import { gotoSignedIn } from './signed-in';

/*
 * Literals copied from `strings.ts`, as the other specs do, so a wording
 * change fails here rather than silently testing the wrong control.
 */
const NEW_COMPANY = 'New company';
const CREATE = 'Create';
const ADD_ROLE = 'Add role';
const COMPANY_SECTION = 'Company';
const PLANNER = 'Default planner';
const SAVE = 'Save';
const DELETE_COMPANY = 'Delete company';

test.use({ storageState: hasSignInCredentials ? AUTH_STATE_PATH : undefined });

test.skip(
  !hasSignInCredentials,
  'Requires TEST_USERNAME/TEST_PASSWORD (the signed-in session) — see ' +
    'scripts/run-browser-tests.sh.',
);

/*
 * The whole journey runs as the signed-in person, who becomes the company's
 * creator. No machine-token fixture: the machine client isn't a member of a
 * company the person creates, so it couldn't clean up after it anyway. The
 * test deletes the company itself as its last step; a failure before that
 * leaves one randomly named company on the testing stack.
 */
test('a company is created, given a planner and a new name, then deleted', async ({
  page,
}) => {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const name = `Journey ${suffix}`;
  const renamed = `Renamed ${suffix}`;

  await gotoSignedIn(page, '/companies');
  await page
    .getByRole('button', { name: NEW_COMPANY, exact: true })
    .first()
    .click();

  const create = page.getByRole('dialog', { name: NEW_COMPANY });
  await create.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await expect(
    create.getByRole('textbox', { name: 'Slug', exact: true }),
  ).toHaveValue(`journey-${suffix}`);
  await create
    .getByRole('textbox', { name: 'Description', exact: true })
    .fill('Made by company.spec.ts');
  await create.getByRole('button', { name: CREATE, exact: true }).click();

  // Creating lands on the new company's roles, ready to add the first.
  await expect(page).toHaveURL(/\/company\/[^/]+#admin\/roles$/);
  await page.getByRole('button', { name: ADD_ROLE, exact: true }).click();
  const roleDialog = page.getByRole('dialog', { name: ADD_ROLE });
  await roleDialog
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill('Planner');
  await roleDialog
    .getByRole('textbox', { name: 'Description', exact: true })
    .fill('Plans the work.');
  await roleDialog
    .getByRole('textbox', { name: 'Role prompt', exact: true })
    .fill('Plan the work.');
  await roleDialog.getByRole('button', { name: ADD_ROLE, exact: true }).click();
  const saved = page.getByRole('dialog', { name: 'Planner', exact: true });
  await expect(saved).toBeVisible();
  // The saved dialog offers both an icon Close and a text one.
  await saved
    .getByRole('button', { name: 'Close', exact: true })
    .first()
    .click();

  await page
    .getByRole('option', { name: COMPANY_SECTION, exact: true })
    .click();
  const section = page.getByRole('region', { name: COMPANY_SECTION });
  const nameField = section.getByRole('textbox', { name: 'Name', exact: true });
  await nameField.fill(renamed);
  // Opened from the keyboard: a click's release can pick the option that
  // lands under the pointer when the list opens over its own trigger.
  await section.getByRole('button', { name: new RegExp(PLANNER) }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('option', { name: 'Planner', exact: true }).click();
  await section.getByRole('button', { name: SAVE, exact: true }).click();
  // The page heading follows the saved name; the announcement is too brief
  // to wait on.
  await expect(
    page.getByRole('heading', { level: 1, name: renamed }),
  ).toBeVisible();

  await page.reload();
  await expect(nameField).toHaveValue(renamed);
  await expect(
    section.getByRole('button', { name: new RegExp(PLANNER) }),
  ).toHaveText(/Planner/);

  await section
    .getByRole('button', { name: DELETE_COMPANY, exact: true })
    .click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: DELETE_COMPANY, exact: true })
    .click();
  await expect(page).toHaveURL(/\/companies$/);
  await expect(page.getByRole('link', { name: renamed })).toHaveCount(0);
});
