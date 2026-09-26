import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../../strings';
import { expectNoA11yViolations } from '../../../test-support/axe';
import {
  installFetchMock,
  respondByRoute,
} from '../../../test-support/fetch-mock';
import CompanyVisualisation from './CompanyVisualisation';

// `phaser` is mocked globally in `test-setup.ts` — real Phaser cannot even be
// imported under jsdom. This suite only needs the real, unmocked
// `TcpPhaserEventBus` and office model underneath that mock, so the summary
// below reflects what `useOfficeWorld` actually built from the fetched roles.

const ROLES_ROUTE = /\/api\/company\/[^/]+\/roles/;
const AGENTS_ROUTE = /\/api\/agent\?/;
const TASKS_ROUTE = /\/api\/task\?/;
const ASSIGNMENTS_ROUTE = /\/api\/assignment\?/;
const CONVERSATIONS_ROUTE = /\/api\/conversation\?/;

const ROLES = [
  { id: 'role-1', name: 'Engineer' },
  { id: 'role-2', name: 'Reviewer' },
];

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
      [ROLES_ROUTE, { body: ROLES }],
      [AGENTS_ROUTE, { body: [] }],
      [TASKS_ROUTE, { body: [] }],
      [ASSIGNMENTS_ROUTE, { body: [] }],
      [CONVERSATIONS_ROUTE, { body: [] }],
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the office stage, described by the roles, task rooms and agents it holds', async () => {
    renderCompanyVisualisation();

    const stage = await screen.findByRole('group', {
      name: t('visualisation.stage.label'),
    });

    // The two roles arrive asynchronously and only then turn into avatars, so
    // the description starts at zero and has to be awaited separately from
    // finding the stage itself.
    await waitFor(() =>
      expect(stage).toHaveAccessibleDescription(
        t('visualisation.summary', { roles: 2, taskRooms: 0, agents: 0 }),
      ),
    );
  });

  it('has no accessibility violations', async () => {
    const { container } = renderCompanyVisualisation();

    await screen.findByRole('group', {
      name: t('visualisation.stage.label'),
    });
    await expectNoA11yViolations(container);
  });
});
