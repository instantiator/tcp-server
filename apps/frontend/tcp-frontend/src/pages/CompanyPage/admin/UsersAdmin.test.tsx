import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { t } from '../../../strings';
import { expectNoA11yViolations } from '../../../test-support/axe';
import {
  installFetchMock,
  respondByRoute,
  respondWithJson,
} from '../../../test-support/fetch-mock';
import { UsersAdmin } from './UsersAdmin';

const member = (
  identifier: string,
  name: string | null,
  memberType: 'creator' | 'owner' | 'member',
  roles: string[] = [],
) => ({ identifier, name, memberType, roles });

const USERS = [
  member('writer@example.com', 'Wanda Writer', 'member', ['Writer', 'Analyst']),
  member('ada@example.com', 'Ada Admin', 'creator'),
  member('anon@example.com', null, 'owner'),
];

const USERS_ROUTE = /\/api\/company\/c1\/users$/;

const renderUsers = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <main>
        <UsersAdmin companyId="c1" />
      </main>
    </QueryClientProvider>,
  );

/** The names in the order the table shows them. */
const shownNames = () =>
  screen.getAllByRole('rowheader').map((cell) => cell.textContent);

describe('UsersAdmin', () => {
  beforeEach(() => {
    installFetchMock();
    respondByRoute([[USERS_ROUTE, { body: USERS }]]);
  });

  it('lists the members with their member type and roles, and says what membership grants', async () => {
    renderUsers();
    await screen.findByRole('rowheader', { name: 'Ada Admin' });

    expect(screen.getByText(t('admin.users.note'))).toBeInTheDocument();
    const row = screen.getByRole('row', { name: /Wanda Writer/ });
    expect(within(row).getByText(t('memberType.member'))).toBeInTheDocument();
    expect(within(row).getByText('Writer, Analyst')).toBeInTheDocument();
    expect(
      within(screen.getByRole('row', { name: /Ada Admin/ })).getByText(
        t('memberType.creator'),
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(t('admin.users.noName'))).toBeInTheDocument();
    await expectNoA11yViolations(document.body);
  });

  it('sorts by name, both ways', async () => {
    const user = userEvent.setup();
    renderUsers();
    await screen.findByRole('rowheader', { name: 'Ada Admin' });

    // A nameless member sorts by identifier, so "anon@…" lands after "Ada".
    expect(shownNames()).toEqual([
      'Ada Admin',
      t('admin.users.noName'),
      'Wanda Writer',
    ]);
    await user.click(
      screen.getByRole('columnheader', { name: t('admin.users.column.name') }),
    );
    expect(shownNames()).toEqual([
      'Wanda Writer',
      t('admin.users.noName'),
      'Ada Admin',
    ]);
  });

  it('filters by name, and says when nothing matches', async () => {
    const user = userEvent.setup();
    renderUsers();
    await screen.findByRole('rowheader', { name: 'Ada Admin' });

    const filter = screen.getByRole('textbox', {
      name: t('admin.users.filter'),
    });
    await user.type(filter, 'WANDA');
    expect(shownNames()).toEqual(['Wanda Writer']);

    await user.clear(filter);
    await user.type(filter, 'zzz');
    expect(
      screen.getByText(t('admin.users.noMatch', { filter: 'zzz' })),
    ).toBeInTheDocument();
  });

  it('shows the empty state, still with the note, when there are no members', async () => {
    respondByRoute([[USERS_ROUTE, { body: [] }]]);
    renderUsers();
    expect(await screen.findByText(t('admin.users.empty'))).toBeInTheDocument();
    expect(screen.getByText(t('admin.users.note'))).toBeInTheDocument();
    await expectNoA11yViolations(document.body);
  });

  it('shows an error with Retry that fetches again', async () => {
    respondWithJson(500, { statusCode: 500, message: 'boom' });
    const user = userEvent.setup();
    renderUsers();
    expect(await screen.findByText(t('admin.users.error'))).toBeInTheDocument();

    respondByRoute([[USERS_ROUTE, { body: USERS }]]);
    await user.click(
      screen.getByRole('button', { name: t('state.error.retry') }),
    );
    expect(
      await screen.findByRole('rowheader', { name: 'Ada Admin' }),
    ).toBeInTheDocument();
  });
});
