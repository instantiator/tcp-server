import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { t } from '../strings';
import { expectNoA11yViolations } from '../test-support/axe';
import { ThemeControl } from './ThemeControl';
import { ThemeProvider } from './ThemeProvider';
import '../styles/base.css';
import '../styles/themes/default.css';
import '../styles/themes/high-contrast.css';

/** Reads a token as the browser would resolve it, through the theme selectors. */
const token = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

describe('ThemeControl', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.mode;
  });

  it('exposes both axes as radio groups, with the current choice checked', () => {
    render(
      <ThemeProvider>
        <ThemeControl />
      </ThemeProvider>,
    );

    // Asserting against `t(...)` rather than the literal English is the point,
    // though it is worth being precise about what it catches: a string
    // inlined in JSX passes here until its value drifts from the lookup, at
    // which point every query for it fails at once (ADR-021). It is a drift
    // detector, not a guard against inlining.
    expect(
      screen.getByRole('radiogroup', { name: t('theme.palette.label') }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('radiogroup', { name: t('theme.mode.label') }),
    ).toBeInTheDocument();

    // test-setup.ts reports "no preference" for every media query, so the
    // seeded choice is default/light.
    expect(
      screen.getByRole('radio', { name: t('theme.palette.default') }),
    ).toBeChecked();
    expect(
      screen.getByRole('radio', { name: t('theme.mode.light') }),
    ).toBeChecked();
  });

  it('changes the applied custom properties when a palette is chosen', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeControl />
      </ThemeProvider>,
    );

    await user.click(
      screen.getByRole('radio', { name: t('theme.palette.highContrast') }),
    );

    expect(document.documentElement.dataset.theme).toBe('high-contrast');
    expect(token('--tcp-color-text')).toBe('#000000');
  });

  it('is operable by keyboard alone', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeControl />
      </ThemeProvider>,
    );

    // Tab reaches the first radio group's checked option; arrow-down is the
    // radio-group pattern for moving to the next option and selecting it in
    // one action. This proves React Aria's keyboard behaviour actually reaches
    // the provider, not just that a click handler is wired up.
    await user.tab();
    await user.keyboard('{ArrowDown}');

    expect(
      screen.getByRole('radio', { name: t('theme.palette.highContrast') }),
    ).toBeChecked();
    expect(document.documentElement.dataset.theme).toBe('high-contrast');
  });

  it('shows a visible focus indicator on the focused option', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeControl />
      </ThemeProvider>,
    );

    await user.tab();

    const focused = document.activeElement;
    const label = focused?.closest('.react-aria-RadioButton');

    // React Aria emits this attribute whether or not any stylesheet acts on
    // it, so on its own it only proves the hook exists.
    expect(label).toHaveAttribute('data-focus-visible');

    // This is the half that bites. jsdom applies the cascade but neither
    // expands shorthands nor resolves `var()`, so the declared shorthand is
    // all that can be read back — and it is empty unless the
    // `[data-focus-visible]` rule in `styles/base.css` matched. Deleting that
    // rule fails here; asserting the attribute alone would not have noticed.
    expect(getComputedStyle(label as Element).outline).not.toBe('');
  });

  // The selected-state indicator is drawn with a `::before` pseudo-element,
  // and jsdom returns defaults for `getComputedStyle(el, '::before')` rather
  // than resolving it. That a chosen option is visibly distinct is therefore
  // proved in the browser tier (`test/browser/app-shell.spec.ts`), not here.

  it('has no accessibility violations in either palette', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ThemeProvider>
        <ThemeControl />
      </ThemeProvider>,
    );

    await expectNoA11yViolations(container);

    await user.click(
      screen.getByRole('radio', { name: t('theme.palette.highContrast') }),
    );

    await expectNoA11yViolations(container);
  });
});
