import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../strings';
import {
  fetchMock,
  installFetchMock,
  requestedUrls,
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
}) => ({
  id: overrides.id,
  slug: overrides.id,
  name: overrides.name,
  description: '',
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

const renderCompaniesPage = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <CompaniesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

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

  it('shows the empty state, pointing at tcp-cli, when there are no companies', async () => {
    respondWithJson(200, []);
    renderCompaniesPage();

    expect(
      await screen.findByRole('heading', {
        name: t('companies.empty.heading'),
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/tcp-cli/)).toBeInTheDocument();
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
});
