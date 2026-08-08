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
  requestedUrls,
  respondByRoute,
  type RouteResponse,
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

// 007.01 gives the activity panel content: mounting it fires five more
// queries (roles, agents, tasks, assignments, conversations) alongside the
// company detail request this suite already made. `respondWithJson`'s
// call-ordered queue answers exactly one request in the order it arrives, so
// it stops being the right tool the moment a render fires six — the panel's
// own coverage lives in `activity/CompanyActivity.test.tsx`, this file only
// needs every route answered so it does not error.
const ROLES_ROUTE = /\/api\/company\/[^/]+\/roles/;
const COMPANY_ROUTE = /\/api\/company\/[^/]+(\?|$)/;
const AGENTS_ROUTE = /\/api\/agent\?/;
const TASKS_ROUTE = /\/api\/task\?/;
const ASSIGNMENTS_ROUTE = /\/api\/assignment\?/;
const CONVERSATIONS_ROUTE = /\/api\/conversation\?/;

interface CompanyPageRoutes {
  readonly company?: RouteResponse;
  readonly roles?: RouteResponse;
  readonly agents?: RouteResponse;
  readonly tasks?: RouteResponse;
  readonly assignments?: RouteResponse;
  readonly conversations?: RouteResponse;
}

/**
 * Answers the company detail request and the activity panel's five, so
 * every test that reaches a loaded company renders cleanly. `ROLES_ROUTE`
 * precedes `COMPANY_ROUTE`: both match a naive `/api/company/...` pattern,
 * and `respondByRoute` takes the first match, so the more specific one has
 * to come first.
 */
const respondCompanyPage = (overrides: CompanyPageRoutes = {}): void => {
  respondByRoute([
    [ROLES_ROUTE, overrides.roles ?? { body: [] }],
    [COMPANY_ROUTE, overrides.company ?? { body: COMPANY }],
    [AGENTS_ROUTE, overrides.agents ?? { body: [] }],
    [TASKS_ROUTE, overrides.tasks ?? { body: [] }],
    [ASSIGNMENTS_ROUTE, overrides.assignments ?? { body: [] }],
    [CONVERSATIONS_ROUTE, overrides.conversations ?? { body: [] }],
  ]);
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
    respondCompanyPage();
    renderCompanyPage();

    expect(
      await screen.findByRole('heading', { name: COMPANY.name, level: 1 }),
    ).toBeInTheDocument();

    // The route-change announcement reads `document.title` back, so a page that
    // left the placeholder in place would announce "Company" for every company.
    expect(document.title).toBe(COMPANY.name);
  });

  it('navigates back to the overview through the breadcrumb', async () => {
    respondCompanyPage();
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
    respondCompanyPage();
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
    respondCompanyPage();
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

    // 007.01 gives the panel real content — the task status filter — so it is
    // no longer empty. React Aria's `TabPanel` is only a tab stop in its own
    // right (`tabIndex={0}`) while it holds nothing focusable; that is the
    // ARIA authoring-practices behaviour for tabs, not something this page
    // opts into. With focusable content inside, the panel itself is skipped
    // and `Tab` lands on the first focusable descendant instead — here, the
    // first status checkbox.
    await user.tab();
    expect(
      screen.getByRole('checkbox', { name: t('activity.status.ready') }),
    ).toHaveFocus();
  });

  it('loads a company from a deep link, without visiting the overview first', async () => {
    respondCompanyPage();
    renderCompanyPage();

    expect(
      await screen.findByRole('heading', { name: COMPANY.name, level: 1 }),
    ).toBeInTheDocument();

    // The activity panel mounts five queries of its own the moment the
    // company resolves, so the page no longer makes exactly one request in
    // total. The point of this test is that a deep link fetches its own
    // company detail without a prior visit to the overview having primed the
    // cache — so assert on the company request specifically, not the count
    // of every request the page happens to make.
    const companyRequests = requestedUrls().filter((url) =>
      COMPANY_ROUTE.test(url),
    );
    expect(companyRequests).toHaveLength(1);
  });

  it('offers a way back when the company is not available', async () => {
    // What a member of nothing gets for a company that exists: a settled,
    // successful request that carries no company.
    respondCompanyPage({ company: { body: null } });
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
    respondCompanyPage();
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
    respondCompanyPage({
      company: { status: 500, body: { statusCode: 500, message: 'boom' } },
    });
    const user = userEvent.setup();
    renderCompanyPage();

    expect(
      await screen.findByText(t('company.error.failed')),
    ).toBeInTheDocument();

    respondCompanyPage();
    await user.click(
      screen.getByRole('button', { name: t('state.error.retry') }),
    );

    expect(
      await screen.findByRole('heading', { name: COMPANY.name, level: 1 }),
    ).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    respondCompanyPage();
    const { container } = renderCompanyPage();

    await screen.findByRole('heading', { name: COMPANY.name, level: 1 });
    await expectNoA11yViolations(container);
  });
});
