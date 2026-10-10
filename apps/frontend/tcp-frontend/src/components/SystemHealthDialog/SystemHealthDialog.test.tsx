import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t, tCount } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import {
  fetchMock,
  installFetchMock,
  respondWithJson,
} from '../../test-support/fetch-mock';
import { SystemHealthDialog } from './SystemHealthDialog';

const ok = {
  status: 'ok',
  services: [
    { name: 'tcp-server', status: 'up' },
    { name: 'tcp-mcp-memory', status: 'not_configured' },
  ],
};

const down = (names: string[]) => ({
  status: 'degraded',
  services: [
    { name: 'tcp-server', status: 'up' },
    ...names.map((name) => ({
      name,
      status: 'down',
      error: `${name} refused`,
    })),
  ],
});

const renderDialog = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <SystemHealthDialog onClose={vi.fn()} />
    </QueryClientProvider>,
  );

describe('SystemHealthDialog', () => {
  beforeEach(() => {
    installFetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists every service with its status in words', async () => {
    respondWithJson(200, ok);
    renderDialog();

    expect(await screen.findByText('tcp-server: Up')).toBeInTheDocument();
    expect(screen.getByText('tcp-mcp-memory: Not configured')).toBeVisible();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('shows a down service with its error', async () => {
    respondWithJson(200, down(['tcp-agent']));
    renderDialog();

    expect(await screen.findByText('tcp-agent: Down')).toBeInTheDocument();
    expect(screen.getByText('tcp-agent refused')).toBeInTheDocument();
  });

  it('says all services are up when the status is ok', async () => {
    respondWithJson(200, ok);
    renderDialog();

    expect(await screen.findByText(t('systemHealth.allUp'))).toBeVisible();
  });

  it.each([1, 2])('counts %i down services', async (n) => {
    respondWithJson(200, down(['tcp-agent', 'tcp-mcp-tasks'].slice(0, n)));
    renderDialog();

    expect(
      await screen.findByText(tCount('systemHealth.down', n)),
    ).toBeVisible();
  });

  it('fetches again on Refresh', async () => {
    respondWithJson(200, ok);
    respondWithJson(200, down(['tcp-agent']));
    const user = userEvent.setup();
    renderDialog();
    await screen.findByText(t('systemHealth.allUp'));

    await user.click(
      screen.getByRole('button', { name: t('systemHealth.refresh') }),
    );

    expect(await screen.findByText('tcp-agent: Down')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('holds the full report as JSON in a disclosure', async () => {
    respondWithJson(200, ok);
    renderDialog();
    await screen.findByText(t('systemHealth.allUp'));

    expect(screen.getByText(t('systemHealth.fullReport'))).toBeInTheDocument();
    const pre = document.querySelector('pre');
    expect(JSON.parse(pre?.textContent ?? '')).toEqual(ok);
  });

  it('shows the error state when the fetch fails', async () => {
    respondWithJson(500, { statusCode: 500, message: 'boom' });
    renderDialog();

    expect(
      await screen.findByText(t('systemHealth.error')),
    ).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    respondWithJson(200, down(['tcp-agent']));
    renderDialog();
    await screen.findByText('tcp-agent: Down');

    await expectNoA11yViolations(document.body);
  });
});
