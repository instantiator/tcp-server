import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../test-support/axe';
import { ThemeProvider } from './ThemeProvider';
import { THEME_STORAGE_KEY } from './storage';
import { useTheme } from './useTheme';
import '../styles/themes/default.css';
import '../styles/themes/high-contrast.css';

/** Reads a token as the browser would resolve it, through the theme selectors. */
const token = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * A test-only surface onto the theme context, kept deliberately minimal so
 * these tests cover the provider rather than `ThemeControl` — which has its
 * own tests.
 */
const Harness = () => {
  const { theme, mode, setTheme, setMode } = useTheme();
  return (
    <div>
      <span data-testid="choice">{`${theme}/${mode}`}</span>
      <button
        type="button"
        onClick={() => {
          setTheme('high-contrast');
        }}
      >
        contrast
      </button>
      <button
        type="button"
        onClick={() => {
          setMode('dark');
        }}
      >
        dark
      </button>
    </div>
  );
};

describe('the theme seam', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.mode;
  });

  it('seeds from the system settings when nothing is stored', () => {
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>,
    );

    // test-setup.ts reports "no preference" for every media query.
    expect(screen.getByTestId('choice')).toHaveTextContent('default/light');
    expect(token('--tcp-color-bg')).toBe('#ffffff');
  });

  it('changes the applied custom properties when the theme changes', async () => {
    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>,
    );
    expect(token('--tcp-color-text')).toBe('#1f2328');

    await userEvent.click(screen.getByRole('button', { name: 'contrast' }));

    expect(document.documentElement.dataset.theme).toBe('high-contrast');
    expect(token('--tcp-color-text')).toBe('#000000');

    await userEvent.click(screen.getByRole('button', { name: 'dark' }));

    expect(token('--tcp-color-bg')).toBe('#000000');
    expect(token('--tcp-color-text')).toBe('#ffffff');
  });

  it("remembers the user's choice across a reload", async () => {
    const first = render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'contrast' }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toContain('high-contrast');

    // Stand in for a page load: tear the tree down and clear the attributes
    // the previous mount applied, leaving only what was persisted.
    first.unmount();
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.mode;

    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('choice')).toHaveTextContent(
      'high-contrast/light',
    );
    expect(token('--tcp-color-text')).toBe('#000000');
  });

  it('does not let the system settings override a stored choice', () => {
    localStorage.setItem(
      THEME_STORAGE_KEY,
      JSON.stringify({ theme: 'default', mode: 'dark' }),
    );

    render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('choice')).toHaveTextContent('default/dark');
    expect(token('--tcp-color-bg')).toBe('#0d1117');
  });

  it('has no accessibility violations in either theme', async () => {
    const { container } = render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>,
    );

    await expectNoA11yViolations(container);

    await userEvent.click(screen.getByRole('button', { name: 'contrast' }));

    await expectNoA11yViolations(container);
  });
});
