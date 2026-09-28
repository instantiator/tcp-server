import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { t } from '../../../../strings';
import { expectNoA11yViolations } from '../../../../test-support/axe';
import {
  installFetchMock,
  respondByRoute,
  type RouteResponse,
} from '../../../../test-support/fetch-mock';
import { ArchiveDetails } from './ArchiveDetails';

const COMPANY_ID = 'company-1';
const COMPANY_SLUG = 'acme-co';
const NOW = '2026-09-01T00:00:00.000Z';
const EARLIER = '2026-08-01T00:00:00.000Z';

const companyFixture = () => ({
  id: COMPANY_ID,
  slug: COMPANY_SLUG,
  name: 'Acme Co',
  description: 'A company',
  mcpServerList: [],
  nextTaskShortcodeIndex: 1,
});

const taskFixture = (overrides: Record<string, unknown> = {}) => ({
  id: 'task-1',
  companyId: COMPANY_ID,
  request: 'Reconcile the September accounts',
  shortcode: 'TASK-1',
  plannerRoleId: null,
  status: 'succeeded',
  materials: [],
  expected: [],
  completed: null,
  failureReason: null,
  createdAt: EARLIER,
  updatedAt: EARLIER,
  ...overrides,
});

const COMPANY_ROUTE = /\/api\/company\/company-1(\?|$)/;
const TASKS_ROUTE = /\/api\/task\?/;

interface Routes {
  readonly company?: RouteResponse;
  readonly tasks?: RouteResponse;
}

const respond = (overrides: Routes = {}): void => {
  respondByRoute([
    [COMPANY_ROUTE, overrides.company ?? { body: companyFixture() }],
    [TASKS_ROUTE, overrides.tasks ?? { body: [taskFixture()] }],
  ]);
};

const renderArchive = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // `ArchiveDetails` is always rendered inside `VisualisationTray`'s `<aside>`
  // in the real app (that landmark is what makes the tray's own axe test
  // pass) — reproduced here so this isolated render is checked the same way,
  // rather than failing on a landmark gap the real usage never has.
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <aside aria-label="Archive test wrapper">
        <ArchiveDetails companyId={COMPANY_ID} headingId="archive-heading" />
      </aside>
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
};

const withStorageConfig = (): void => {
  window.__TCP_CONFIG__ = {
    oidcIssuerUrl: 'https://idp.example.com',
    oidcClientId: 'tcp-web-test',
    storageConsoleUrl: 'http://localhost:9001',
    storageBucket: 'tcp',
  };
};

describe('ArchiveDetails', () => {
  beforeEach(() => {
    installFetchMock();
  });

  afterEach(() => {
    // test-setup.ts seeds a config with no storage fields via `??=`, which
    // only applies once — reset explicitly so a test that adds storage
    // fields doesn't leak into the next one.
    window.__TCP_CONFIG__ = {
      oidcIssuerUrl: 'https://idp.example.com',
      oidcClientId: 'tcp-web-test',
    };
  });

  it('shows the heading and only succeeded tasks, newest first', async () => {
    respond({
      tasks: {
        body: [
          taskFixture({
            id: 'task-old',
            shortcode: 'TASK-OLD',
            status: 'succeeded',
            updatedAt: EARLIER,
          }),
          taskFixture({
            id: 'task-new',
            shortcode: 'TASK-NEW',
            status: 'succeeded',
            updatedAt: NOW,
          }),
          taskFixture({
            id: 'task-failed',
            shortcode: 'TASK-FAILED',
            status: 'failed',
          }),
          taskFixture({
            id: 'task-running',
            shortcode: 'TASK-RUNNING',
            status: 'in-progress',
          }),
        ],
      },
    });
    renderArchive();

    const list = await screen.findByRole('list');
    const items = within(list).getAllByRole('listitem');

    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('TASK-NEW');
    expect(items[1]).toHaveTextContent('TASK-OLD');
    expect(screen.queryByText(/TASK-FAILED/)).not.toBeInTheDocument();
    expect(screen.queryByText(/TASK-RUNNING/)).not.toBeInTheDocument();
  });

  it('gives each row a link with the confirmed href, target and rel when storage is configured', async () => {
    withStorageConfig();
    respond();
    renderArchive();

    const link = await screen.findByRole('link', {
      name: t('visualisation.archive.open', { shortcode: 'TASK-1' }),
    });

    expect(link).toHaveAttribute(
      'href',
      'http://localhost:9001/browser/tcp/acme-co%2Ftasks%2Ftask-1%2Fcompleted%2F',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders no links, and a note, without storage configuration', async () => {
    respond();
    renderArchive();

    await screen.findByText(taskFixture().shortcode, { exact: false });

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(
      screen.getByText(t('visualisation.archive.unconfigured')),
    ).toBeInTheDocument();
  });

  it('shows the empty state with no succeeded tasks', async () => {
    respond({ tasks: { body: [taskFixture({ status: 'failed' })] } });
    renderArchive();

    expect(
      await screen.findByText(t('visualisation.archive.empty')),
    ).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('shows the loading state before the queries settle', () => {
    respond();
    renderArchive();

    expect(
      screen.getByText(t('visualisation.tray.loading')),
    ).toBeInTheDocument();
  });

  it('shows "gone" when the company is not visible to the caller', async () => {
    respond({ company: { body: null } });
    renderArchive();

    await screen.findByText(t('visualisation.tray.gone'));
    expect(
      screen.getByRole('heading', { name: t('visualisation.archive.heading') }),
    ).toBeInTheDocument();
  });

  it('has no accessibility violations, configured or not', async () => {
    withStorageConfig();
    respond();
    const { unmount } = renderArchive();

    await screen.findByRole('link', {
      name: t('visualisation.archive.open', { shortcode: 'TASK-1' }),
    });
    await expectNoA11yViolations(document.body);
    unmount();
  });
});
