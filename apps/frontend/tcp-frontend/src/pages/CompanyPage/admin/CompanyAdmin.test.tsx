import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { announce } from '../../../announce/announcer';
import { t } from '../../../strings';
import { expectNoA11yViolations } from '../../../test-support/axe';
import {
  fetchMock,
  installFetchMock,
  respondByRoute,
} from '../../../test-support/fetch-mock';
import { CompanyAdmin } from './CompanyAdmin';

vi.mock('../../../announce/announcer', () => ({ announce: vi.fn() }));

const COMPANY = {
  id: 'c1',
  slug: 'acme',
  name: 'Acme',
  description: 'Makes things',
  companyContext: 'We make anvils.',
  versionRetentionDays: 30,
  plannerRoleId: 'r1',
};

const ROLES = [
  { id: 'r1', companyId: 'c1', name: 'Planner' },
  { id: 'r2', companyId: 'c1', name: 'Writer' },
];

const routes = (company: object = COMPANY) =>
  [
    [/\/api\/company\/c1\/roles$/, { body: ROLES }],
    [/\/api\/company\/c1$/, { body: company }],
  ] as const;

const render_ = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={['/companies/acme']}>
        <Routes>
          <Route
            path="/companies/acme"
            element={<CompanyAdmin companyId="c1" />}
          />
          <Route path="/companies" element={<p>Companies list</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

/** The requests made so far with this method. */
const requests = (method: string): Request[] =>
  fetchMock.mock.calls
    .map(([input]) => input)
    .filter(
      (input): input is Request =>
        input instanceof Request && input.method === method,
    );

const sentBodies = async (): Promise<unknown[]> =>
  Promise.all(requests('PUT').map((request) => request.clone().json()));

type User = ReturnType<typeof userEvent.setup>;

const field = async (label: string) =>
  screen.findByRole('textbox', { name: new RegExp(`^${label}`) });

const save = (user: User) =>
  user.click(screen.getByRole('button', { name: t('admin.company.save') }));

/** Opens the planner list from the keyboard and picks `name`. */
const choosePlanner = async (user: User, name: string | RegExp) => {
  const button = await screen.findByRole('button', {
    name: new RegExp(t('admin.company.planner')),
  });
  button.focus();
  await user.keyboard('{Enter}');
  await user.click(await screen.findByRole('option', { name }));
};

describe('CompanyAdmin', () => {
  beforeEach(() => {
    installFetchMock();
    respondByRoute([...routes()]);
    vi.mocked(announce).mockClear();
  });

  it('shows the slug as read-only text and preselects the current planner', async () => {
    render_();
    expect(
      await screen.findByText(t('admin.company.slug', { slug: 'acme' })),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Default planner/ }),
    ).toHaveTextContent('Planner');
  });

  it('sends nothing when nothing changed', async () => {
    const user = userEvent.setup();
    render_();
    await field(t('admin.company.name'));
    await save(user);
    expect(await sentBodies()).toEqual([]);
    expect(announce).not.toHaveBeenCalled();
  });

  it('sends only the name after editing only the name', async () => {
    const user = userEvent.setup();
    render_();
    const name = await field(t('admin.company.name'));
    await user.clear(name);
    await user.type(name, 'Acme Ltd');
    await save(user);

    await waitFor(() => expect(announce).toHaveBeenCalled());
    expect(await sentBodies()).toEqual([{ name: 'Acme Ltd' }]);
    expect(announce).toHaveBeenCalledWith({
      channel: 'company',
      change: 'admin.company.announce.saved',
    });
  });

  it('refuses an empty name and sends nothing', async () => {
    const user = userEvent.setup();
    render_();
    await user.clear(await field(t('admin.company.name')));
    await save(user);
    expect(await screen.findByText(t('admin.company.required'))).toBeVisible();
    expect(await sentBodies()).toEqual([]);
  });

  it('clears the company context with null', async () => {
    const user = userEvent.setup();
    render_();
    await user.clear(await field(t('admin.company.context')));
    await save(user);
    await waitFor(() => expect(announce).toHaveBeenCalled());
    expect(await sentBodies()).toEqual([{ companyContext: null }]);
  });

  it('clears the retention with null', async () => {
    const user = userEvent.setup();
    render_();
    await user.clear(await field(t('admin.company.retention')));
    await save(user);
    await waitFor(() => expect(announce).toHaveBeenCalled());
    expect(await sentBodies()).toEqual([{ versionRetentionDays: null }]);
  });

  it.each(['0', '3651', 'abc'])('blocks a retention of %s', async (value) => {
    const user = userEvent.setup();
    render_();
    const retention = await field(t('admin.company.retention'));
    await user.clear(retention);
    await user.type(retention, value);
    await save(user);
    expect(
      await screen.findByText(t('admin.company.retentionInvalid')),
    ).toBeVisible();
    expect(retention).toHaveFocus();
    expect(await sentBodies()).toEqual([]);
  });

  it('blocks an unknown time zone and focuses it', async () => {
    const user = userEvent.setup();
    render_();
    await field(t('admin.company.name'));
    await user.type(
      screen.getByRole('combobox', { name: /Time zone/ }),
      'Nowhere/Land',
    );
    await save(user);
    expect(
      await screen.findByText(t('admin.company.timezoneInvalid')),
    ).toBeVisible();
    expect(screen.getByRole('combobox', { name: /Time zone/ })).toHaveFocus();
    expect(await sentBodies()).toEqual([]);
  });

  it('sends the id of a chosen planner', async () => {
    const user = userEvent.setup();
    render_();
    await choosePlanner(user, 'Writer');
    await save(user);
    await waitFor(() => expect(announce).toHaveBeenCalled());
    expect(await sentBodies()).toEqual([{ plannerRoleId: 'r2' }]);
  });

  it('sends null when the planner is set to None', async () => {
    const user = userEvent.setup();
    render_();
    await choosePlanner(user, /^None/);
    await save(user);
    await waitFor(() => expect(announce).toHaveBeenCalled());
    expect(await sentBodies()).toEqual([{ plannerRoleId: null }]);
  });

  it('lists the server’s warnings after a save', async () => {
    const user = userEvent.setup();
    const base = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input, init) =>
      input instanceof Request && input.method === 'PUT'
        ? Promise.resolve(
            new Response(JSON.stringify(COMPANY), {
              status: 200,
              headers: {
                'Content-Type': 'application/json',
                'X-Tcp-Warnings': JSON.stringify([
                  encodeURIComponent('Planner has no model.'),
                ]),
              },
            }),
          )
        : (base?.(input, init) ?? Promise.reject(new Error('no fetch'))),
    );
    render_();
    await user.type(await field(t('admin.company.name')), '!');
    await save(user);
    expect(await screen.findByText('Planner has no model.')).toBeVisible();
  });

  describe('deleting', () => {
    const openConfirm = async (user: User) => {
      await user.click(
        await screen.findByRole('button', { name: t('admin.company.delete') }),
      );
      return within(
        await screen.findByRole('alertdialog', {
          name: t('admin.company.deleteHeading', { name: 'Acme' }),
        }),
      );
    };

    it('sends nothing when cancelled', async () => {
      const user = userEvent.setup();
      render_();
      const dialog = await openConfirm(user);
      await user.click(dialog.getByRole('button', { name: t('confirm.no') }));
      expect(requests('DELETE')).toEqual([]);
    });

    it('deletes the company and goes to the list when confirmed', async () => {
      const user = userEvent.setup();
      const base = fetchMock.getMockImplementation();
      fetchMock.mockImplementation((input, init) =>
        input instanceof Request && input.method === 'DELETE'
          ? Promise.resolve(new Response(null, { status: 204 }))
          : (base?.(input, init) ?? Promise.reject(new Error('no fetch'))),
      );
      render_();
      const dialog = await openConfirm(user);
      await user.click(
        dialog.getByRole('button', { name: t('admin.company.deleteConfirm') }),
      );

      expect(await screen.findByText('Companies list')).toBeVisible();
      expect(requests('DELETE').map((request) => request.url)).toEqual([
        expect.stringMatching(/\/api\/company\/c1$/),
      ]);
      expect(announce).toHaveBeenCalledWith({
        channel: 'company',
        change: 'admin.company.announce.deleted',
        params: { name: 'Acme' },
      });
    });

    it('shows a failure under the button and returns focus to it', async () => {
      const user = userEvent.setup();
      const base = fetchMock.getMockImplementation();
      fetchMock.mockImplementation((input, init) =>
        input instanceof Request && input.method === 'DELETE'
          ? Promise.resolve(
              new Response(JSON.stringify({ message: 'Nope' }), {
                status: 409,
                headers: { 'Content-Type': 'application/json' },
              }),
            )
          : (base?.(input, init) ?? Promise.reject(new Error('no fetch'))),
      );
      render_();
      const dialog = await openConfirm(user);
      await user.click(
        dialog.getByRole('button', { name: t('admin.company.deleteConfirm') }),
      );

      expect(await screen.findByText(/wasn’t deleted/)).toBeVisible();
      expect(
        screen.getByRole('button', { name: t('admin.company.delete') }),
      ).toHaveFocus();
    });
  });

  it('has no accessibility violations', async () => {
    render_();
    await field(t('admin.company.name'));
    await expectNoA11yViolations(document.body);
  });
});
