import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { t } from '../../../strings';
import {
  installFetchMock,
  respondByRoute,
  type RouteResponse,
} from '../../../test-support/fetch-mock';
import { AgentsList } from './AgentsList';

const COMPANY_ID = 'company-1';
const NOW = '2026-08-10T00:00:00.000Z';
const AGENTS_ROUTE = /\/api\/agent(\?|$)/;

interface AgentOverrides {
  readonly id: string;
  readonly status: string;
  readonly pauseReason?: string | null;
  readonly resumeAfter?: string | null;
  readonly roleId?: string;
}

const agentRow = (overrides: AgentOverrides) => ({
  id: overrides.id,
  companyId: COMPANY_ID,
  roleId: overrides.roleId ?? 'role-1',
  assignmentId: 'assignment-1',
  status: overrides.status,
  threadId: null,
  initialPrompt: 'Do the thing',
  createdAt: NOW,
  updatedAt: NOW,
  output: null,
  rateLimitRetries: 0,
  ...(overrides.pauseReason !== undefined && {
    pauseReason: overrides.pauseReason,
  }),
  ...(overrides.resumeAfter !== undefined && {
    resumeAfter: overrides.resumeAfter,
  }),
});

const respondAgents = (agents: RouteResponse): void => {
  respondByRoute([[AGENTS_ROUTE, agents]]);
};

const renderAgents = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <AgentsList
          companyId={COMPANY_ID}
          roleNames={new Map([['role-1', 'Developer']])}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('AgentsList', () => {
  beforeEach(() => {
    installFetchMock();
  });

  it('shows a plain paused agent as "Paused"', async () => {
    respondAgents({ body: [agentRow({ id: 'agent-1', status: 'paused' })] });
    renderAgents();

    expect(
      await screen.findByText(t('activity.status.paused')),
    ).toBeInTheDocument();
  });

  it('shows the next-try time for a rate-limited pause', async () => {
    const resumeAfter = '2026-08-10T09:05:00.000Z';
    respondAgents({
      body: [
        agentRow({
          id: 'agent-1',
          status: 'paused',
          pauseReason: 'rate_limited',
          resumeAfter,
        }),
      ],
    });
    renderAgents();

    const time = new Intl.DateTimeFormat(undefined, {
      timeStyle: 'short',
    }).format(new Date(resumeAfter));
    expect(
      await screen.findByText(t('activity.status.rateLimited', { time })),
    ).toBeInTheDocument();
  });

  it('shows "resume by hand" for a rate-limited pause with no scheduled retry', async () => {
    respondAgents({
      body: [
        agentRow({
          id: 'agent-1',
          status: 'paused',
          pauseReason: 'rate_limited',
          resumeAfter: null,
        }),
      ],
    });
    renderAgents();

    expect(
      await screen.findByText(t('activity.status.rateLimited.manual')),
    ).toBeInTheDocument();
  });
});
