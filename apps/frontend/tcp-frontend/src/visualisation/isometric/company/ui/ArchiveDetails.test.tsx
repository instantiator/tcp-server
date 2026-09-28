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

/** A link's full accessible name: its visible row, then the hidden suffix. */
const linkName = (shortcode: string, request: string): string =>
  `${t('visualisation.archive.row', { shortcode, request })} ${t('visualisation.archive.linkSuffix')}`;

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
      name: linkName('TASK-1', 'Reconcile the September accounts'),
    });

    expect(link).toHaveAttribute(
      'href',
      'http://localhost:9001/browser/tcp/acme-co%2Ftasks%2Ftask-1%2Fcompleted%2F',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  /**
   * WCAG 2.5.3 (label in name): the visible row leads the accessible name, so
   * a speech-input user saying what they see reaches the link. An
   * `aria-label` naming the shortcode alone would replace the row and fail
   * this. The hidden rest of the name says where the link goes and that it
   * opens a new tab, and the shortcode keeps every name distinct (2.4.4).
   */
  it('names each link by its visible row first, then where it goes, uniquely', async () => {
    withStorageConfig();
    respond({
      tasks: {
        body: [
          taskFixture({ id: 'task-a', shortcode: 'TASK-A', updatedAt: NOW }),
          taskFixture({ id: 'task-b', shortcode: 'TASK-B' }),
        ],
      },
    });
    renderArchive();

    const list = await screen.findByRole('list');
    const links = await within(list).findAllByRole('link');
    expect(links).toHaveLength(2);

    for (const shortcode of ['TASK-A', 'TASK-B']) {
      const row = t('visualisation.archive.row', {
        shortcode,
        request: 'Reconcile the September accounts',
      });
      // The exact name, so the visible row is its start, not merely in it.
      const link = within(list).getByRole('link', {
        name: `${row} ${t('visualisation.archive.linkSuffix')}`,
      });
      // Only the suffix is hidden; everything else is what a sighted user
      // reads.
      const hidden = link.querySelector('.visually-hidden');
      expect(hidden?.textContent?.trim()).toBe(
        t('visualisation.archive.linkSuffix'),
      );
      expect(
        link.textContent?.replace(hidden?.textContent ?? '', '').trim(),
      ).toBe(row);
    }
    // The same request on two tasks: the names still differ.
    const names = links.map((link) => link.textContent);
    expect(new Set(names).size).toBe(names.length);
    expect(t('visualisation.archive.linkSuffix')).toMatch(/new tab/);
  });

  it("marks a clipped request with '…', so the row doesn't read as the whole of it", async () => {
    const longRequest = `Reconcile every account in the ledger. ${'Trace each discrepancy back to its journal entry. '.repeat(4)}`;
    respond({ tasks: { body: [taskFixture({ request: longRequest })] } });
    renderArchive();

    const item = await screen.findByRole('listitem');
    expect(item.textContent).toMatch(/…$/);
    expect(item.textContent).not.toContain(longRequest);
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

  it('has no accessibility violations with links', async () => {
    withStorageConfig();
    respond();
    renderArchive();

    await screen.findByRole('link', {
      name: linkName('TASK-1', 'Reconcile the September accounts'),
    });
    await expectNoA11yViolations(document.body);
  });

  it('has no accessibility violations without storage configuration', async () => {
    respond();
    renderArchive();

    await screen.findByText(t('visualisation.archive.unconfigured'));
    await screen.findByRole('list');
    await expectNoA11yViolations(document.body);
  });
});
