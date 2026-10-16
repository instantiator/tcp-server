import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { t } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import {
  installFetchMock,
  requestedUrls,
  respondByRoute,
} from '../../test-support/fetch-mock';
import { DocumentsPanel } from './DocumentsPanel';

const EARLIER = '2026-08-01T00:00:00.000Z';
const LATER = '2026-09-01T00:00:00.000Z';
const TASKS_ROUTE = /\/api\/task\?/;

const task = (overrides: Record<string, unknown>) => ({
  id: 'task-1',
  companyId: 'c1',
  request: 'Reconcile the accounts',
  shortcode: 'TASK-1',
  plannerRoleId: null,
  status: 'succeeded',
  materials: [],
  expected: [],
  completed: null,
  failureReason: null,
  failureCode: null,
  createdAt: EARLIER,
  updatedAt: EARLIER,
  ...overrides,
});

const BASE_CONFIG = {
  oidcIssuerUrl: 'https://idp.example.com',
  oidcClientId: 'tcp-web-test',
};

const renderPanel = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <main>
        <DocumentsPanel companyId="c1" companySlug="acme" />
      </main>
    </QueryClientProvider>,
  );

/** A link's accessible name: its visible label, then the hidden new-tab suffix. */
const linkName = (label: string) => `${label} ${t('documents.linkSuffix')}`;

describe('DocumentsPanel', () => {
  beforeEach(() => {
    installFetchMock();
    respondByRoute([
      [
        TASKS_ROUTE,
        {
          body: [
            task({}),
            task({ id: 'task-2', shortcode: 'TASK-2', updatedAt: LATER }),
            task({ id: 'task-3', shortcode: 'TASK-3', status: 'in-progress' }),
          ],
        },
      ],
    ]);
  });

  afterEach(() => {
    window.__TCP_CONFIG__ = BASE_CONFIG;
  });

  it('links the root, the resources and each succeeded task, newest first', async () => {
    window.__TCP_CONFIG__ = {
      ...BASE_CONFIG,
      storageConsoleUrl: 'http://localhost:9001',
      storageBucket: 'tcp',
    };
    renderPanel();

    const table = screen.getByRole('table', { name: t('documents.heading') });
    await within(table).findByRole('link', {
      name: linkName(
        t('documents.taskOutputs', {
          shortcode: 'TASK-2',
          request: 'Reconcile the accounts',
        }),
      ),
    });
    const links = within(table).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'http://localhost:9001/browser/tcp/acme%2F',
      'http://localhost:9001/browser/tcp/acme%2Fresources%2F',
      'http://localhost:9001/browser/tcp/acme%2Ftasks%2Ftask-2%2Fcompleted%2F',
      'http://localhost:9001/browser/tcp/acme%2Ftasks%2Ftask-1%2Fcompleted%2F',
    ]);
    expect(links[0]).toHaveAccessibleName(linkName(t('documents.root')));
    expect(links[0]).toHaveAttribute('target', '_blank');
    await expectNoA11yViolations(document.body);
  });

  it('refetches the tasks on Refresh', async () => {
    window.__TCP_CONFIG__ = {
      ...BASE_CONFIG,
      storageConsoleUrl: 'http://localhost:9001',
      storageBucket: 'tcp',
    };
    const user = userEvent.setup();
    renderPanel();
    await screen.findAllByRole('link', { name: /TASK-1/ });
    const before = requestedUrls().filter((u) => TASKS_ROUTE.test(u)).length;

    await user.click(
      screen.getByRole('button', { name: t('documents.refresh') }),
    );

    expect(
      requestedUrls().filter((u) => TASKS_ROUTE.test(u)).length,
    ).toBeGreaterThan(before);
  });

  it('says so, and links nothing, without the storage browser configured', () => {
    renderPanel();
    expect(screen.getByText(t('documents.unconfigured'))).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
