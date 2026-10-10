import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { virtual } from '@guidepup/virtual-screen-reader';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { getUserManager } from './auth/user-manager';
import { t } from './strings';
import { expectNoA11yViolations } from './test-support/axe';
import { fetchMock, installFetchMock } from './test-support/fetch-mock';
import { renderAppAt, TEST_SESSION } from './test-support/render-app';
import { ThemeProvider } from './theme/ThemeProvider';

const renderApp = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ThemeProvider>
        <MemoryRouter initialEntries={['/']}>
          <App />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );

describe('App', () => {
  beforeEach(() => {
    // Since 006.01 the guarded pages fetch on mount, so an unstubbed `fetch`
    // here would reach a real server — slow when there is one and an unhandled
    // rejection when there is not. This file is about routing, focus and
    // announcements; what each page does with its data is its own suite's
    // subject, so the stub answers with the emptiest *valid* body per route.
    //
    // Per route, and not one body for all of them: the list route always
    // returns an array and the detail route returns `null` for a company the
    // caller cannot see. A single answer would be wrong for one of them, and
    // wrong in a way that crashes the page rather than emptying it.
    installFetchMock();
    fetchMock.mockImplementation((input) => {
      const url = input instanceof Request ? input.url : String(input);
      // The company page a deep link can land on also reads the spend
      // endpoints (000.02), which answer with an object rather than a list —
      // the array fallback below would otherwise crash it.
      // The shell's system banner reads the status on every signed-in page.
      const body = url.endsWith('/api/system/status')
        ? JSON.stringify({
            admin: false,
            shutdown: { state: 'idle', restart: false },
          })
        : /\/api\/company\/[^/]+$/.test(url)
          ? 'null'
          : /\/api\/spend(\?|$)/.test(url)
            ? JSON.stringify({ trackingSince: null, providers: [], caps: [] })
            : /\/api\/company\/[^/]+\/spend$/.test(url)
              ? JSON.stringify({
                  trackingSince: null,
                  providers: [],
                  tasks: [],
                  series: [],
                })
              : '[]';
      return Promise.resolve(
        new Response(body, {
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the landing page through the full provider stack', () => {
    renderApp();

    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('resolves its heading through the strings lookup, not a literal', () => {
    renderApp();

    // Asserting against `t(...)` rather than 'TCP' is the point: this fails if
    // a component ever inlines the string in JSX (ADR-021).
    expect(
      screen.getByRole('heading', { name: t('app.title') }),
    ).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = renderApp();

    await expectNoA11yViolations(container);
  });

  it('recovers rather than bouncing to the landing page when there is no session', () => {
    // Since 004.03, a guarded route with no session redirects to the identity
    // provider instead of the landing page (`RequireSession`'s reload
    // recovery) — `session.test.tsx` is where that redirect and its no-loop
    // guarantee are exercised in full; this is only the regression gate for
    // the destination changing under `MemoryRouter`, which never leaves the
    // app and so never actually reaches the provider.
    //
    // The redirect itself is stubbed out and never resolves: this test only
    // needs the state the component is in before that promise settles, and a
    // real, unmocked `signinRedirect()` would otherwise reject against a
    // discovery document jsdom cannot fetch.
    vi.spyOn(getUserManager(), 'signinRedirect').mockReturnValue(
      new Promise(() => undefined),
    );

    renderAppAt('/companies');

    expect(
      screen.getByRole('progressbar', {
        name: t('state.loading', { label: t('session.recovering') }),
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(t('page.companies.title'))).toBeNull();
    expect(screen.queryByRole('heading', { name: t('app.title') })).toBeNull();
  });

  it('renders a protected route when there is a session', () => {
    renderAppAt('/companies', TEST_SESSION);

    expect(
      screen.getByRole('heading', { name: t('page.companies.title') }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: t('header.account.label') }),
    ).toBeInTheDocument();
  });

  it('renders a deep link directly, resolving its route parameter', async () => {
    // Arrived at, not navigated to — that distinction is the whole test,
    // because in-app navigation would pass even if the route table could not
    // resolve the URL cold.
    renderAppAt('/company/acme', TEST_SESSION);

    // The stubbed server knows no companies, so the page settles on its
    // unavailable state. That it settles at all is what proves the parameter
    // reached the page: with no `companyId` there would be nothing to ask for.
    expect(
      await screen.findByRole('heading', {
        name: t('company.unavailable.heading'),
      }),
    ).toBeInTheDocument();
  });

  it('renders the not-found page for an unknown address, signed out', () => {
    renderAppAt('/nothing-here');

    expect(
      screen.getByRole('heading', { name: t('page.notFound.title') }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: t('header.account.label') }),
    ).toBeNull();
  });

  it('renders exactly one main element', () => {
    // This is the gate for a carried-forward warning from 003.01:
    // `LandingPage.test.tsx` scans the page in isolation and cannot see a
    // second `main` — this can, because it renders the whole shell.
    const landing = renderAppAt('/');
    expect(document.querySelectorAll('main')).toHaveLength(1);
    landing.unmount();

    // `/callback` is the other route outside the shell, so it owns its own
    // `main` for the same reason the landing page does.
    const callback = renderAppAt('/callback');
    expect(document.querySelectorAll('main')).toHaveLength(1);
    callback.unmount();

    renderAppAt('/companies', TEST_SESSION);
    expect(document.querySelectorAll('main')).toHaveLength(1);
  });

  it('puts the skip link first in the tab order, pointing at main', async () => {
    const user = userEvent.setup();
    renderAppAt('/companies', TEST_SESSION);

    await user.tab();

    // jsdom does not implement fragment-navigation focus at all, so this
    // proves the wiring only — that focus actually lands on `main` is proven
    // in the browser tier (test/browser/app-shell.spec.ts), and this test
    // must not be read as covering it.
    const skipLink = screen.getByRole('link', {
      name: t('shell.skipToContent'),
    });
    expect(document.activeElement).toBe(skipLink);
    expect(skipLink).toHaveAttribute('href', '#main-content');
    expect(document.getElementById('main-content')).not.toBeNull();
  });

  it('moves focus to the main heading on a route change', async () => {
    const user = userEvent.setup();
    renderAppAt('/nothing-here');

    await user.click(
      screen.getByRole('link', { name: t('page.notFound.home') }),
    );

    const heading = screen.getByRole('heading', { name: t('app.title') });
    expect(document.activeElement).toBe(heading);
    expect(heading.tabIndex).toBe(-1);
  });

  describe('screen reader announcements on route change', () => {
    afterEach(async () => {
      await virtual.stop();
    });

    it("announces the new page's title on a route change", async () => {
      const user = userEvent.setup();
      renderAppAt('/nothing-here');

      await virtual.start({ container: document.body });
      // start() announces the container itself ("document"). Clear it, so
      // the log holds only what the announcer chose to say.
      await virtual.clearSpokenPhraseLog();

      await user.click(
        screen.getByRole('link', { name: t('page.notFound.home') }),
      );

      // The announcer speaks from a timer rather than from the render that
      // triggered it, so the click returning is not the announcement landing.
      await vi.waitFor(async () => {
        expect(await virtual.spokenPhraseLog()).toContain(
          `polite: ${t('app.title')}`,
        );
      });
    });

    it('announces once under StrictMode, not twice', async () => {
      const user = userEvent.setup();
      // `renderAppAt` includes StrictMode, as `main.tsx` does — which
      // double-invokes every effect on mount. 003.02 shipped a route-change
      // guard that this spent, and stayed green because the helper did not.
      renderAppAt('/nothing-here');

      await virtual.start({ container: document.body });
      await virtual.clearSpokenPhraseLog();

      await user.click(
        screen.getByRole('link', { name: t('page.notFound.home') }),
      );

      // The log also carries the focus move onto the heading, which is the
      // other half of ADR-027's route-change row and belongs there. Only the
      // spoken announcement is counted.
      await vi.waitFor(async () => {
        const announcements = (await virtual.spokenPhraseLog()).filter(
          (phrase) => phrase === `polite: ${t('app.title')}`,
        );
        expect(announcements).toHaveLength(1);
      });
    });

    it('neither announces nor moves focus on first render', async () => {
      renderAppAt('/companies', TEST_SESSION);

      await virtual.start({ container: document.body });
      await virtual.clearSpokenPhraseLog();

      // Arriving at a URL is not a route change, and yanking focus on load
      // is a worse experience than the browser's own starting position.
      expect(await virtual.spokenPhraseLog()).toEqual([]);
      expect(document.activeElement).toBe(document.body);
    });
  });

  it("renders exactly one live region, and it is the announcer's", () => {
    renderAppAt('/companies', TEST_SESSION);

    // The regression gate for replacing 003.02's `<p role="status">` rather
    // than adding a second region beside it. Two regions updating together
    // interleave into output that reads as neither message (ADR-027), and
    // nothing else in the suite would notice.
    expect(document.querySelectorAll('[data-live-announcer]')).toHaveLength(1);
    expect(document.querySelector('p[role="status"]')).toBeNull();
  });

  it('has no accessibility violations across the shell', async () => {
    const companies = renderAppAt('/companies', TEST_SESSION);
    await expectNoA11yViolations(document.body);
    companies.unmount();

    renderAppAt('/nothing-here');
    await expectNoA11yViolations(document.body);
  });
});
