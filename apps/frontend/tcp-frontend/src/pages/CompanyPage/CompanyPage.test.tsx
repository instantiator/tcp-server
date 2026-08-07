import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { t } from '../../strings';
import { CompanyPage } from './CompanyPage';

// The page now subscribes to its live event stream (005.02) via
// `useEventStream`, which needs a `QueryClientProvider` above it for
// `useQueryClient()` to resolve. The stream itself is `useEventStream`'s own
// concern (`../../events/useEventStream.test.tsx`) — mocked out here so this
// stays a test of the render, not of `connect`'s auth and network stack.
vi.mock('../../events/useEventStream', () => ({
  useEventStream: vi.fn(() => ({ error: null })),
}));

const renderCompanyPage = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={['/company/acme']}>
        <Routes>
          <Route path="/company/:companyId" element={<CompanyPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('CompanyPage', () => {
  it('names itself in the heading and the document title', () => {
    renderCompanyPage();

    expect(
      screen.getByRole('heading', { name: t('page.company.title') }),
    ).toBeInTheDocument();

    // Catches a page that forgets `useDocumentTitle` and therefore announces
    // the previous page's name on arrival.
    expect(document.title).toBe(t('page.company.title'));
  });
});
