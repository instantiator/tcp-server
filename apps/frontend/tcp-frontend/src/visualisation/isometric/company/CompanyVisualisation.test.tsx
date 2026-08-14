import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installFetchMock,
  respondByRoute,
} from '../../../test-support/fetch-mock';
import CompanyVisualisation from './CompanyVisualisation';

// `phaser` is mocked globally in `test-setup.ts` — real Phaser cannot even be
// imported under jsdom. This suite only needs the real, unmocked
// `TcpPhaserEventBus` underneath that mock, to drive the click round-trip
// below.

const ROLES_ROUTE = /\/api\/company\/[^/]+\/roles/;
const AGENTS_ROUTE = /\/api\/agent\?/;
const TASKS_ROUTE = /\/api\/task\?/;

const renderCompanyVisualisation = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <CompanyVisualisation companyId="company-1" />
    </QueryClientProvider>,
  );

describe('CompanyVisualisation', () => {
  beforeEach(() => {
    installFetchMock();
    respondByRoute([
      [ROLES_ROUTE, { body: [] }],
      [AGENTS_ROUTE, { body: [] }],
      [TASKS_ROUTE, { body: [] }],
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a TcpPhaserVisualisation', () => {
    const { container } = renderCompanyVisualisation();

    // `#game-container` is TcpPhaserVisualisation's own render — its
    // presence is what proves CompanyVisualisation mounted it, without
    // reaching into an implementation detail like a mocked child component.
    expect(container.querySelector('#game-container')).not.toBeNull();
  });
});
