import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import { t } from './strings';
import { expectNoA11yViolations } from './test-support/axe';
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
});
