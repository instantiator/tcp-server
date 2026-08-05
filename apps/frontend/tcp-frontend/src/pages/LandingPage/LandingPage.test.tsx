import { vi } from 'vitest';

vi.mock('../../auth/sign-in', () => ({ startSignIn: vi.fn() }));

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { startSignIn } from '../../auth/sign-in';
import { t } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import { THEME_STORAGE_KEY } from '../../theme/storage';
import { ThemeProvider } from '../../theme/ThemeProvider';
import { LandingPage } from './LandingPage';
import '../../styles/themes/default.css';
import '../../styles/themes/high-contrast.css';

/** Reads a token as the browser would resolve it, through the theme selectors. */
const token = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Renders the page through the same provider stack `App.test.tsx` uses. */
const renderLandingPage = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ThemeProvider>
        <MemoryRouter initialEntries={['/']}>
          <LandingPage />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );

describe('LandingPage', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.mode;
    vi.mocked(startSignIn).mockClear();
  });

  it('forms a heading outline with no level skipped', () => {
    renderLandingPage();

    const headings = screen
      .getAllByRole('heading')
      .map((h) => [Number(h.tagName.slice(1)), h.textContent]);

    // Asserting the whole outline in order catches a skipped level, which axe
    // does not: axe only flags an h1-to-h3 jump if both are present and
    // nested, not a missing middle level entirely.
    expect(headings).toEqual([
      [1, t('app.title')],
      [2, t('landing.getStarted.heading')],
      [2, t('landing.appearance.heading')],
    ]);
  });

  it('explains what the system is', () => {
    renderLandingPage();

    expect(screen.getByText(t('landing.intro'))).toBeInTheDocument();
  });

  it('starts sign-in when the control is pressed', async () => {
    const user = userEvent.setup();
    renderLandingPage();

    await user.click(screen.getByRole('button', { name: t('landing.signIn') }));

    expect(startSignIn).toHaveBeenCalledTimes(1);
  });

  it('reaches and operates the sign-in control by keyboard alone', async () => {
    const user = userEvent.setup();
    const first = renderLandingPage();

    // The sign-in button is the first focusable element on the page.
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: t('landing.signIn') }),
    );

    await user.keyboard('{Enter}');
    expect(startSignIn).toHaveBeenCalledTimes(1);

    // A native <button> answers both Enter and Space; re-render and repeat
    // with Space to prove the control is a real button, not a click handler
    // on a div that only happens to catch Enter.
    first.unmount();
    vi.mocked(startSignIn).mockClear();
    renderLandingPage();

    await user.tab();
    await user.keyboard(' ');
    expect(startSignIn).toHaveBeenCalledTimes(1);
  });

  it('switches theme from this page, and remembers the choice', async () => {
    const user = userEvent.setup();
    const first = renderLandingPage();

    await user.click(
      screen.getByRole('radio', { name: t('theme.palette.highContrast') }),
    );
    await user.click(screen.getByRole('radio', { name: t('theme.mode.dark') }));

    expect(document.documentElement.dataset.theme).toBe('high-contrast');
    expect(document.documentElement.dataset.mode).toBe('dark');
    expect(token('--tcp-color-bg')).toBe('#000000');

    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    expect(stored).toContain('high-contrast');
    expect(stored).toContain('dark');

    // Stand in for a page load: tear the tree down and clear the attributes
    // the previous mount applied, leaving only what was persisted.
    first.unmount();
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.mode;

    renderLandingPage();

    expect(
      screen.getByRole('radio', { name: t('theme.palette.highContrast') }),
    ).toBeChecked();
    expect(
      screen.getByRole('radio', { name: t('theme.mode.dark') }),
    ).toBeChecked();
    expect(token('--tcp-color-bg')).toBe('#000000');
  });

  it('has no accessibility violations', async () => {
    const { container } = renderLandingPage();

    await expectNoA11yViolations(container);
  });
});
