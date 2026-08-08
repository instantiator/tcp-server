import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEventStream } from '../../events/useEventStream';
import { t } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import {
  fetchMock,
  installFetchMock,
  respondWithJson,
} from '../../test-support/fetch-mock';
import { CompanyPage } from './CompanyPage';

// The stream is `useEventStream`'s own concern, covered in
// `../../events/useEventStream.test.tsx`. Mocked here so this stays a test of
// the render rather than of `connect`'s auth and network stack — and so the
// stream-failure case can be driven directly.
vi.mock('../../events/useEventStream', () => ({
  useEventStream: vi.fn(() => ({ error: null })),
}));

const streamReturns = vi.mocked(useEventStream);

const COMPANY = {
  id: 'company-1',
  slug: 'acme',
  name: 'Acme Corporation',
  description: 'A company',
};

/**
 * Both routes are registered, not just the one under test: the breadcrumb's
 * whole job is to navigate, and a test that renders the company page alone can
 * only assert that a link exists.
 */
const renderCompanyPage = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={['/company/company-1']}>
        <Routes>
          <Route path="/companies" element={<h1>Overview stub</h1>} />
          <Route path="/company/:companyId" element={<CompanyPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('CompanyPage', () => {
  beforeEach(() => {
    installFetchMock();
    streamReturns.mockReturnValue({ error: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('names the company in the heading and the document title', async () => {
    respondWithJson(200, COMPANY);
    renderCompanyPage();

    expect(
      await screen.findByRole('heading', { name: COMPANY.name, level: 1 }),
    ).toBeInTheDocument();

    // The route-change announcement reads `document.title` back, so a page that
    // left the placeholder in place would announce "Company" for every company.
    expect(document.title).toBe(COMPANY.name);
  });

  it('navigates back to the overview through the breadcrumb', async () => {
    respondWithJson(200, COMPANY);
    const user = userEvent.setup();
    renderCompanyPage();

    await screen.findByRole('heading', { name: COMPANY.name, level: 1 });

    // The current company is the last crumb, so it is marked rather than linked.
    expect(
      screen.getByText(COMPANY.name, { selector: 'span' }),
    ).toHaveAttribute('aria-current', 'page');

    await user.click(
      screen.getByRole('link', { name: t('page.companies.title') }),
    );

    expect(
      await screen.findByRole('heading', { name: 'Overview stub' }),
    ).toBeInTheDocument();
  });

  it('renders a labelled tab list with one selected tab and its panel', async () => {
    respondWithJson(200, COMPANY);
    renderCompanyPage();

    const tabList = await screen.findByRole('tablist', {
      name: t('company.tabs.label'),
    });
    expect(tabList).toBeInTheDocument();

    const tab = screen.getByRole('tab', { name: t('company.tab.activity') });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toBeInTheDocument();
  });

  it('follows the tab pattern from the keyboard, even at one tab', async () => {
    respondWithJson(200, COMPANY);
    const user = userEvent.setup();
    renderCompanyPage();

    const tab = await screen.findByRole('tab', {
      name: t('company.tab.activity'),
    });

    tab.focus();
    expect(tab).toHaveFocus();

    // A single tab has nowhere to go, so every navigation key is a no-op that
    // leaves it focused and selected. Asserting the degenerate case is what
    // makes 010.01's second tab a one-line change rather than a redesign: if
    // this were a hand-rolled panel, none of these keys would do anything at
    // all and nothing here would notice.
    for (const key of ['{ArrowRight}', '{ArrowLeft}', '{Home}', '{End}']) {
      await user.keyboard(key);
      expect(tab).toHaveFocus();
      expect(tab).toHaveAttribute('aria-selected', 'true');
    }

    // The tab list is one tab stop; the next moves into the panel it controls.
    await user.tab();
    expect(screen.getByRole('tabpanel')).toHaveFocus();
  });

  it('loads a company from a deep link, without visiting the overview first', async () => {
    respondWithJson(200, COMPANY);
    renderCompanyPage();

    expect(
      await screen.findByRole('heading', { name: COMPANY.name, level: 1 }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('offers a way back when the company is not available', async () => {
    // What a member of nothing gets for a company that exists: a settled,
    // successful request that carries no company.
    respondWithJson(200, null);
    renderCompanyPage();

    expect(
      await screen.findByRole('heading', {
        name: t('company.unavailable.heading'),
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: t('company.unavailable.back') }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('shows a stream failure without taking the page down with it', async () => {
    streamReturns.mockReturnValue({ error: new Error('stream gone') });
    respondWithJson(200, COMPANY);
    renderCompanyPage();

    expect(
      await screen.findByText(t('company.stream.failed')),
    ).toBeInTheDocument();

    // The company is still readable and still navigable — only stale. Awaited
    // separately: the stream error renders on the first paint, while the
    // company is still in flight, so finding it proves nothing about the tabs.
    expect(
      await screen.findByRole('tablist', { name: t('company.tabs.label') }),
    ).toBeInTheDocument();
  });

  it('shows a progress bar while loading, and marks the region busy', () => {
    // Never resolved — the assertion happens before it would be.
    fetchMock.mockReturnValueOnce(new Promise(() => undefined));
    renderCompanyPage();

    const progressBar = screen.getByRole('progressbar');
    expect(progressBar.closest('.company-page__body')).toHaveAttribute(
      'aria-busy',
      'true',
    );
  });

  it('shows a failure message on a 500, and retries on request', async () => {
    respondWithJson(500, { statusCode: 500, message: 'boom' });
    const user = userEvent.setup();
    renderCompanyPage();

    expect(
      await screen.findByText(t('company.error.failed')),
    ).toBeInTheDocument();

    respondWithJson(200, COMPANY);
    await user.click(
      screen.getByRole('button', { name: t('state.error.retry') }),
    );

    expect(
      await screen.findByRole('heading', { name: COMPANY.name, level: 1 }),
    ).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    respondWithJson(200, COMPANY);
    const { container } = renderCompanyPage();

    await screen.findByRole('heading', { name: COMPANY.name, level: 1 });
    await expectNoA11yViolations(container);
  });
});
