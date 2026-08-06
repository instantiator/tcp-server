import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { virtual } from '@guidepup/virtual-screen-reader';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { t } from './strings';
import { expectNoA11yViolations } from './test-support/axe';
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

  it('redirects a protected route to the landing page when there is no session', () => {
    renderAppAt('/companies');

    expect(
      screen.getByRole('heading', { name: t('app.title') }),
    ).toBeInTheDocument();
    expect(screen.queryByText(t('page.companies.title'))).toBeNull();
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

  it('renders a deep link directly, with its route parameter', () => {
    // Arrived at, not navigated to — that distinction is the whole test,
    // because in-app navigation would pass even if the route table could not
    // resolve the URL cold.
    renderAppAt('/company/acme', TEST_SESSION);

    expect(
      screen.getByRole('heading', { name: t('page.company.title') }),
    ).toBeInTheDocument();
    expect(screen.getByText('acme')).toBeInTheDocument();
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

      expect(await virtual.spokenPhraseLog()).toContain(
        `polite: ${t('app.title')}`,
      );
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

  it('has no accessibility violations across the shell', async () => {
    const companies = renderAppAt('/companies', TEST_SESSION);
    await expectNoA11yViolations(document.body);
    companies.unmount();

    renderAppAt('/nothing-here');
    await expectNoA11yViolations(document.body);
  });
});
