import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { t } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import {
  installFetchMock,
  respondByRoute,
} from '../../test-support/fetch-mock';
import { DocumentsPanel } from './DocumentsPanel';

const EARLIER = '2026-08-01T00:00:00.000Z';
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

const listing = (path: string, folders: string[]) => ({
  path,
  writable: false,
  folders: folders.map((name) => ({
    path: `${path}${name}/`,
    name,
    purpose: null,
  })),
  files: [],
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

describe('DocumentsPanel', () => {
  beforeEach(() => {
    installFetchMock();
    respondByRoute([
      [
        TASKS_ROUTE,
        {
          body: [
            task({}),
            task({
              id: 'task-3',
              shortcode: 'TASK-3',
              status: 'in-progress',
              request: 'Plan',
            }),
          ],
        },
      ],
      [
        /\/storage\/folder\?path=$/,
        { body: listing('', ['resources', 'tasks']) },
      ],
      [/path=tasks%2F$/, { body: listing('tasks/', ['task-1', 'task-3']) }],
    ]);
  });

  afterEach(() => {
    window.__TCP_CONFIG__ = BASE_CONFIG;
  });

  it('shows the company folder as a tree named Documents', async () => {
    renderPanel();

    expect(
      await screen.findByRole('treegrid', { name: t('documents.heading') }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('row', { name: /resources/ })).toBeVisible();
    await expectNoA11yViolations(document.body);
  });

  it('labels each task folder with its shortcode and request', async () => {
    const user = userEvent.setup();
    renderPanel();

    const tasksRow = await screen.findByRole('row', { name: /tasks/ });
    await user.click(within(tasksRow).getByRole('button'));

    for (const [shortcode, request] of [
      ['TASK-1', 'Reconcile the accounts'],
      ['TASK-3', 'Plan'],
    ]) {
      expect(
        await screen.findByRole('row', {
          name: new RegExp(
            t('documents.taskFolder', { shortcode, request }).replace(
              /[.*+?^${}()|[\]\\]/g,
              '\\$&',
            ),
          ),
        }),
      ).toBeInTheDocument();
    }
  });

  it('links to the storage console only when it is configured', async () => {
    window.__TCP_CONFIG__ = {
      ...BASE_CONFIG,
      storageConsoleUrl: 'http://localhost:9001',
      storageBucket: 'tcp',
    };
    renderPanel();

    const link = await screen.findByRole('link', {
      name: `${t('documents.console')} ${t('documents.linkSuffix')}`,
    });
    expect(link).toHaveAttribute(
      'href',
      'http://localhost:9001/browser/tcp/acme%2F',
    );
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('shows no link, and no note, without the console configured', async () => {
    renderPanel();
    await screen.findByRole('treegrid');
    expect(screen.queryByRole('link')).toBeNull();
  });
});
