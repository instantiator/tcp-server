import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../../auth/session';
import { t } from '../../strings';
import {
  fetchMock,
  installFetchMock,
  requestedUrls,
  respondByRoute,
  respondWithJson,
} from '../../test-support/fetch-mock';
import { expectNoA11yViolations } from '../../test-support/axe';
import { CompaniesPage } from './CompaniesPage';

/** A `CompanyListItemDto`, filled in with zeros so a test overrides only what it checks. */
const company = (overrides: {
  id: string;
  name: string;
  activeAgents?: number;
  tasksByStatus?: Partial<Record<string, number>>;
  openEnquiries?: number;
  memberType?: 'creator' | 'member' | 'owner' | null;
}) => ({
  id: overrides.id,
  slug: overrides.id,
  name: overrides.name,
  description: '',
  memberType:
    overrides.memberType === undefined ? 'member' : overrides.memberType,
  stats: {
    activeAgents: overrides.activeAgents ?? 0,
    tasksByStatus: {
      ready: 0,
      planning: 0,
      'in-progress': 0,
      finalising: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      ...overrides.tasksByStatus,
    },
    openEnquiries: overrides.openEnquiries ?? 0,
  },
});

/**
 * Renders the page at `route`. Signed out unless `signedIn`, in which case
 * the system status (and so the admin flag) is fetched, as in the app.
 */
const renderCompaniesPage = (route = '/companies', signedIn = false) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[route]}>
        <SessionProvider session={signedIn ? { userId: 'test-user' } : null}>
          <CompaniesPage />
        </SessionProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

/** Answers the status and company routes, so the page can be driven as an admin or not. */
const respondAs = (admin: boolean, companies: readonly unknown[]) =>
  respondByRoute([
    [
      /\/api\/system\/status/,
      { body: { admin, shutdown: { state: 'idle', restart: false } } },
    ],
    [/\/api\/company/, { body: companies }],
  ]);

/** The `?all` value of each company request so far. */
const companyRequests = () =>
  requestedUrls()
    .filter((url) => url.includes('/api/company'))
    .map((url) => new URL(url).searchParams.get('all'));

describe('CompaniesPage', () => {
  beforeEach(() => {
    installFetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists the returned companies by accessible name', async () => {
    respondWithJson(200, [company({ id: 'company-1', name: 'Acme' })]);
    renderCompaniesPage();

    expect(
      await screen.findByRole('link', { name: 'Acme' }),
    ).toBeInTheDocument();
  });

  it('sends no ?all parameter — that scope is administrator-only', async () => {
    respondWithJson(200, [company({ id: 'company-1', name: 'Acme' })]);
    renderCompaniesPage();

    await screen.findByRole('link', { name: 'Acme' });

    expect(requestedUrls()[0]).not.toContain('all');
  });

  it("shows each company's three figures, summing only the active task statuses", async () => {
    respondWithJson(200, [
      company({
        id: 'company-1',
        name: 'Acme',
        activeAgents: 3,
        // Active statuses sum to 7. `succeeded` and `failed` are non-zero too,
        // so a naive sum over every status (7 + 5 + 2 = 14) fails this test.
        tasksByStatus: {
          ready: 1,
          planning: 2,
          'in-progress': 3,
          finalising: 1,
          succeeded: 5,
          failed: 2,
        },
        openEnquiries: 4,
      }),
    ]);
    renderCompaniesPage();

    await screen.findByRole('link', { name: 'Acme' });

    expect(screen.getByText('3 active agents')).toBeInTheDocument();
    expect(screen.getByText('7 active tasks')).toBeInTheDocument();
    expect(screen.getByText('4 open enquiries')).toBeInTheDocument();
  });

  it('uses the singular form at a count of one, and shows zero rather than hiding it', async () => {
    respondWithJson(200, [
      company({
        id: 'company-1',
        name: 'Acme',
        activeAgents: 1,
        tasksByStatus: { ready: 1 },
        openEnquiries: 0,
      }),
    ]);
    renderCompaniesPage();

    await screen.findByRole('link', { name: 'Acme' });

    expect(screen.getByText('1 active agent')).toBeInTheDocument();
    expect(screen.getByText('1 active task')).toBeInTheDocument();
    expect(screen.getByText('0 open enquiries')).toBeInTheDocument();
  });

  it('makes the whole card a single link to the company, not just its name', async () => {
    respondWithJson(200, [
      company({
        id: 'company-1',
        name: 'Acme',
        activeAgents: 3,
        openEnquiries: 4,
      }),
    ]);
    renderCompaniesPage();

    const link = await screen.findByRole('link', { name: 'Acme' });
    const card = link.closest<HTMLElement>('.companies-page__company');
    expect(card).not.toBeNull();

    // The stretched-link pattern (`tcp-card__link`'s `::after` covering the
    // card) is CSS, which jsdom doesn't render — so a click on a stat line
    // can't be simulated as a navigation here. Instead this asserts the
    // precondition the CSS relies on: exactly one link in the card, named by
    // the company and pointing at its route, so stretching it covers the
    // whole clickable area without adding a second destination.
    const links = card === null ? [] : within(card).getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/company/company-1');
  });

  it('shows a progress bar while loading, and marks the region busy', () => {
    // Never resolved in this test — the assertion happens before it would be.
    fetchMock.mockReturnValueOnce(new Promise(() => undefined));
    renderCompaniesPage();

    const progressBar = screen.getByRole('progressbar');
    expect(progressBar).toBeInTheDocument();
    expect(progressBar.closest('.companies-page__list')).toHaveAttribute(
      'aria-busy',
      'true',
    );
  });

  it('shows a failure message on a 500, and retries on request', async () => {
    respondWithJson(500, { statusCode: 500, message: 'boom' });
    const user = userEvent.setup();
    renderCompaniesPage();

    expect(
      await screen.findByText(t('companies.error.failed')),
    ).toBeInTheDocument();

    respondWithJson(200, []);
    await user.click(
      screen.getByRole('button', { name: t('state.error.retry') }),
    );

    await screen.findByRole('heading', { name: t('companies.empty.heading') });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats a 403 as a refusal, not an empty list', async () => {
    respondWithJson(403, { statusCode: 403, message: 'forbidden' });
    renderCompaniesPage();

    expect(
      await screen.findByText(t('companies.error.forbidden')),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: t('companies.empty.heading') }),
    ).not.toBeInTheDocument();
  });

  it('shows the empty state, offering to create a company', async () => {
    respondWithJson(200, []);
    renderCompaniesPage();

    expect(
      await screen.findByRole('heading', {
        name: t('companies.empty.heading'),
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(t('companies.empty.body'))).toBeInTheDocument();
    // One button in the header and one in the empty state.
    expect(
      screen.getAllByRole('button', { name: t('companies.create.open') }),
    ).toHaveLength(2);
  });

  it('opens the New company dialog from the header button', async () => {
    respondByRoute([
      [
        /\/api\/company/,
        { body: [company({ id: 'company-1', name: 'Acme' })] },
      ],
      [
        /\/api\/system\/llm-defaults$/,
        { body: { chat: null, embedding: null, embeddingDimension: 768 } },
      ],
    ]);
    const user = userEvent.setup();
    renderCompaniesPage();
    await screen.findByRole('link', { name: 'Acme' });

    await user.click(
      screen.getByRole('button', { name: t('companies.create.open') }),
    );

    expect(
      await screen.findByRole('heading', {
        name: t('companies.create.heading'),
      }),
    ).toBeInTheDocument();
  });

  it('titles the document', async () => {
    respondWithJson(200, []);
    renderCompaniesPage();

    await screen.findByRole('heading', { name: t('companies.empty.heading') });
    expect(document.title).toBe(t('page.companies.title'));
  });

  it('has no accessibility violations, populated or empty', async () => {
    respondWithJson(200, [company({ id: 'company-1', name: 'Acme' })]);
    const populated = renderCompaniesPage();
    await screen.findByRole('link', { name: 'Acme' });
    await expectNoA11yViolations(populated.container);
    populated.unmount();

    respondWithJson(200, []);
    const empty = renderCompaniesPage();
    await screen.findByRole('heading', { name: t('companies.empty.heading') });
    await expectNoA11yViolations(empty.container);
  });

  it('opens the template gallery from New company, then a blank form from Start from scratch', async () => {
    respondByRoute([
      [/\/api\/company$/, { body: [] }],
      [/\/api\/template$/, { body: [] }],
      [
        /\/api\/system\/llm-defaults$/,
        { body: { chat: null, embedding: null, embeddingDimension: 768 } },
      ],
    ]);
    const user = userEvent.setup();
    renderCompaniesPage();
    await screen.findByRole('heading', { name: t('companies.empty.heading') });

    await user.click(
      screen.getAllByRole('button', { name: t('companies.create.open') })[0],
    );
    await user.click(
      await screen.findByRole('button', {
        name: t('companies.gallery.scratch'),
      }),
    );

    // The gallery has gone, rather than sitting under the form.
    expect(
      await screen.findByRole('textbox', { name: /^Name/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: t('companies.gallery.scratch') }),
    ).not.toBeInTheDocument();
  });

  describe('scope toggle', () => {
    const scopeGroup = () =>
      screen.queryByRole('radiogroup', { name: t('companies.scope.label') });
    const button = (key: 'mine' | 'all') =>
      screen.getByRole('radio', { name: t(`companies.scope.${key}`) });
    /** The card holding the company link named `name`. */
    const card = (name: string): HTMLElement => {
      const found = screen
        .getByRole('link', { name })
        .closest<HTMLElement>('.companies-page__company');
      if (found === null) throw new Error(`No card for ${name}`);
      return found;
    };

    it('is not offered to a non-admin, who never sends ?all', async () => {
      respondAs(false, [company({ id: 'company-1', name: 'Acme' })]);
      renderCompaniesPage('/companies', true);

      await screen.findByRole('link', { name: 'Acme' });

      expect(scopeGroup()).not.toBeInTheDocument();
      expect(companyRequests()).toEqual([null]);
    });

    it('ignores ?scope=all for a non-admin: own list, no toggle, no ?all', async () => {
      respondAs(false, [company({ id: 'company-1', name: 'Acme' })]);
      renderCompaniesPage('/companies?scope=all', true);

      await screen.findByRole('link', { name: 'Acme' });
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

      expect(scopeGroup()).not.toBeInTheDocument();
      expect(companyRequests().every((all) => all === null)).toBe(true);
    });

    it('shows an admin the group with My companies selected', async () => {
      respondAs(true, [company({ id: 'company-1', name: 'Acme' })]);
      renderCompaniesPage('/companies', true);

      expect(
        await screen.findByRole('radiogroup', {
          name: t('companies.scope.label'),
        }),
      ).toBeInTheDocument();
      expect(button('mine')).toHaveAttribute('aria-checked', 'true');
      expect(button('all')).toHaveAttribute('aria-checked', 'false');
    });

    it('asks for ?all=true when an admin presses All companies', async () => {
      respondAs(true, [company({ id: 'company-1', name: 'Acme' })]);
      const user = userEvent.setup();
      renderCompaniesPage('/companies', true);
      await screen.findByRole('link', { name: 'Acme' });
      await screen.findByRole('radiogroup', {
        name: t('companies.scope.label'),
      });

      respondAs(true, [
        company({ id: 'company-1', name: 'Acme' }),
        company({ id: 'company-2', name: 'Other', memberType: null }),
      ]);
      await user.click(button('all'));

      expect(
        await screen.findByRole('link', { name: 'Other' }),
      ).toBeInTheDocument();
      expect(companyRequests()).toContain('true');
      expect(button('all')).toHaveAttribute('aria-checked', 'true');

      // Going back removes the scope, so the default view asks for no ?all.
      await user.click(button('mine'));
      await waitFor(() =>
        expect(button('mine')).toHaveAttribute('aria-checked', 'true'),
      );
      expect(companyRequests().at(-1)).toBeNull();
    });

    it('asks for all at once when an admin opens ?scope=all', async () => {
      respondAs(true, [company({ id: 'company-1', name: 'Acme' })]);
      renderCompaniesPage('/companies?scope=all', true);

      await waitFor(() =>
        expect(button('all')).toHaveAttribute('aria-checked', 'true'),
      );
      await screen.findByRole('link', { name: 'Acme' });
      expect(companyRequests()).toContain('true');
    });

    it('marks a company the admin is not a member of, in the all view only', async () => {
      const companies = [
        company({ id: 'company-1', name: 'Mine', memberType: 'member' }),
        company({ id: 'company-2', name: 'Theirs', memberType: null }),
      ];
      respondAs(true, companies);
      const user = userEvent.setup();
      renderCompaniesPage('/companies', true);
      await screen.findByRole('link', { name: 'Theirs' });
      expect(
        screen.queryByText(t('companies.notMember')),
      ).not.toBeInTheDocument();

      await user.click(button('all'));
      await waitFor(() =>
        expect(button('all')).toHaveAttribute('aria-checked', 'true'),
      );

      expect(
        within(card('Theirs')).getByText(t('companies.notMember')),
      ).toBeInTheDocument();
      expect(
        within(card('Mine')).queryByText(t('companies.notMember')),
      ).not.toBeInTheDocument();
    });

    it('uses the all-view wording for an empty list', async () => {
      respondAs(true, []);
      renderCompaniesPage('/companies?scope=all', true);

      expect(
        await screen.findByRole('heading', {
          name: t('companies.empty.headingAll'),
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(t('companies.empty.bodyAll')),
      ).toBeInTheDocument();
    });

    it('has no accessibility violations with the toggle showing', async () => {
      respondAs(true, [company({ id: 'company-1', name: 'Acme' })]);
      const { container } = renderCompaniesPage('/companies', true);
      await screen.findByRole('radiogroup', {
        name: t('companies.scope.label'),
      });
      await screen.findByRole('link', { name: 'Acme' });

      await expectNoA11yViolations(container);
    });
  });
});
