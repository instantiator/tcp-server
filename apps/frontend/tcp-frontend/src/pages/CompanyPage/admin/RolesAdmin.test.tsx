import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { announce } from '../../../announce/announcer';
import { t, tCount } from '../../../strings';
import { expectNoA11yViolations } from '../../../test-support/axe';
import {
  fetchMock,
  installFetchMock,
  respondByRoute,
} from '../../../test-support/fetch-mock';
import { RolesAdmin } from './RolesAdmin';

vi.mock('../../../announce/announcer', () => ({ announce: vi.fn() }));

const role = (id: string, name: string, slug: string) => ({
  id,
  companyId: 'c1',
  slug,
  name,
  description: `What ${name} does.`,
  knowledgeDomains: [],
  mcpServerList: [],
  queryIndex: 0,
});

const ROLES = [
  role('r1', 'Writer', 'writer'),
  role('r2', 'Analyst', 'analyst'),
  role('r3', 'Planner', 'planner'),
];

const ROLES_ROUTE = /\/api\/company\/c1\/roles$/;
const COMPANY_ROUTE = /\/api\/company\/c1$/;
const DELETE_ROUTE = /\/api\/role\/r\d$/;

/** Answers the list and the company; every role delete succeeds. */
const respond = (roles = ROLES) =>
  respondByRoute([
    [ROLES_ROUTE, { body: roles }],
    [COMPANY_ROUTE, { body: { id: 'c1', slug: 'acme', plannerRoleId: 'r3' } }],
    [DELETE_ROUTE, { status: 204, body: undefined }],
  ]);

const renderAdmin = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <main>
        <RolesAdmin companyId="c1" />
      </main>
    </QueryClientProvider>,
  );

/** The role names in the order the table shows them. */
const shownNames = () =>
  screen.getAllByRole('rowheader').map((cell) => cell.textContent);

/** The DELETE requests made so far. */
const deletes = () =>
  fetchMock.mock.calls
    .map(([input]) => input)
    .filter(
      (input): input is Request =>
        input instanceof Request && input.method === 'DELETE',
    )
    .map((request) => new URL(request.url).pathname);

describe('RolesAdmin', () => {
  beforeEach(() => {
    installFetchMock();
    respond();
    vi.mocked(announce).mockClear();
  });

  it('lists the roles by name, marks the planner, and sorts both ways', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await screen.findByRole('rowheader', { name: 'Analyst' });

    expect(shownNames()).toEqual(['Analyst', 'Planner', 'Writer']);
    const plannerRow = screen.getByRole('row', { name: 'Planner' });
    expect(
      within(plannerRow).getByText(t('admin.roles.planner')),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('columnheader', { name: t('admin.roles.column.name') }),
    );
    expect(shownNames()).toEqual(['Writer', 'Planner', 'Analyst']);
    await expectNoA11yViolations(document.body);
  });

  it('filters by name, and says when nothing matches', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await screen.findByRole('rowheader', { name: 'Analyst' });

    const filter = screen.getByRole('textbox', {
      name: t('admin.roles.filter'),
    });
    await user.type(filter, 'wri');
    expect(shownNames()).toEqual(['Writer']);

    await user.clear(filter);
    await user.type(filter, 'zzz');
    expect(
      screen.getByText(t('admin.roles.noMatch', { filter: 'zzz' })),
    ).toBeInTheDocument();
  });

  it('offers no delete until a role is selected', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await screen.findByRole('rowheader', { name: 'Analyst' });

    expect(
      screen.getByRole('button', { name: t('admin.roles.deleteNone') }),
    ).toBeDisabled();

    const row = screen.getByRole('row', { name: 'Writer' });
    await user.click(within(row).getByRole('checkbox'));
    expect(
      screen.getByRole('button', { name: tCount('admin.roles.delete', 1) }),
    ).toBeEnabled();
  });

  it('names the roles going, warns only when the planner is one, and deletes nothing on No', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await screen.findByRole('rowheader', { name: 'Analyst' });

    await user.click(
      within(screen.getByRole('row', { name: 'Writer' })).getByRole('checkbox'),
    );
    await user.click(
      screen.getByRole('button', { name: tCount('admin.roles.delete', 1) }),
    );
    const confirm = screen.getByRole('alertdialog', {
      name: tCount('admin.roles.deleteHeading', 1),
    });
    expect(confirm).toHaveTextContent(
      t('admin.roles.deleteMessage', { names: 'Writer' }),
    );
    expect(confirm).not.toHaveTextContent(
      t('admin.roles.deletePlanner', { name: 'Planner' }),
    );
    await user.click(
      within(confirm).getByRole('button', { name: t('confirm.no') }),
    );
    expect(deletes()).toEqual([]);

    await user.click(
      within(screen.getByRole('row', { name: 'Planner' })).getByRole(
        'checkbox',
      ),
    );
    await user.click(
      screen.getByRole('button', { name: tCount('admin.roles.delete', 2) }),
    );
    expect(
      screen.getByRole('alertdialog', {
        name: tCount('admin.roles.deleteHeading', 2),
      }),
    ).toHaveTextContent(t('admin.roles.deletePlanner', { name: 'Planner' }));
  });

  it('deletes on Yes, announces it, and puts focus on the table', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await screen.findByRole('rowheader', { name: 'Analyst' });

    await user.click(
      within(screen.getByRole('row', { name: 'Writer' })).getByRole('checkbox'),
    );
    await user.click(
      screen.getByRole('button', { name: tCount('admin.roles.delete', 1) }),
    );
    respond(ROLES.filter((r) => r.id !== 'r1'));
    await user.click(
      screen.getByRole('button', { name: t('admin.roles.deleteConfirm') }),
    );

    await waitFor(() =>
      expect(announce).toHaveBeenCalledWith({
        channel: 'roles',
        change: 'admin.roles.announce.deleted',
        params: { count: 1 },
      }),
    );
    expect(deletes()).toEqual(['/api/role/r1']);
    // Focus left the confirmation for the table; React Aria hands the grid's
    // focus on to a row inside it.
    await waitFor(() =>
      expect(screen.getByRole('grid')).toContainElement(
        document.activeElement as HTMLElement | null,
      ),
    );
  });

  it('shows the empty state when the company has no roles', async () => {
    respond([]);
    renderAdmin();
    expect(await screen.findByText(t('admin.roles.empty'))).toBeInTheDocument();
    await expectNoA11yViolations(document.body);
  });
});
