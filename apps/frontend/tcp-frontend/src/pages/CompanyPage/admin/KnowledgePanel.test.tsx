import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { announce } from '../../../announce/announcer';
import type { KnowledgeDocumentDTO } from '../../../api/dtos';
import { t, tCount } from '../../../strings';
import { expectNoA11yViolations } from '../../../test-support/axe';
import { fetchMock, installFetchMock } from '../../../test-support/fetch-mock';
import { KnowledgePanel } from './KnowledgePanel';

vi.mock('../../../announce/announcer', async (original) => ({
  ...(await original<typeof import('../../../announce/announcer')>()),
  announce: vi.fn(),
}));

const BASE = '/api/company/c1/knowledge';

const doc = (name: string): KnowledgeDocumentDTO => ({
  key: `acme/knowledge/shared/${name}`,
  name,
  size: 2048,
  lastModified: '2026-10-01T10:00:00.000Z',
});

const status = (overrides: Record<string, unknown> = {}) => ({
  shared: {
    documentCount: 2,
    totalBytes: 4096,
    chunkCount: 7,
    generation: 3,
    lastIndexedAt: '2026-10-01T10:05:00.000Z',
    indexing: false,
    lastError: null,
    lastErrorAt: null,
    ...overrides,
  },
  roles: [],
});

/** What the fake server holds; tests change it between requests. */
interface World {
  docs: ReturnType<typeof doc>[];
  status: ReturnType<typeof status>;
}

const json = (body: unknown, statusCode = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status: statusCode,
    headers: { 'Content-Type': 'application/json' },
  });

/** Every request as `METHOD path?query`, for asserting on what was asked. */
const calls: string[] = [];

/**
 * A fake server answering by method and path. Uploads come through `send`
 * (a URL and an init), the rest through openapi-fetch (a `Request`).
 */
const serve = (world: World) => {
  fetchMock.mockImplementation((input, init) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input,
    );
    const method = request?.method ?? init?.method ?? 'GET';
    calls.push(`${method} ${url.pathname}${url.search}`);
    const path = url.pathname;

    if (path === '/api/company/c1/storage/folder') {
      return Promise.resolve(
        json({
          path: 'knowledge/shared/',
          writable: false,
          folders: [],
          files: world.docs.map((d) => ({
            path: `knowledge/shared/${d.name}`,
            name: d.name,
            size: d.size,
            lastModified: d.lastModified,
          })),
        }),
      );
    }
    if (path === '/api/company/c1/roles') return Promise.resolve(json([]));
    if (method === 'POST' && path === BASE) {
      // An upload queues a rebuild, which the status then shows.
      world.status = status({ indexing: true });
      return Promise.resolve(json(doc('new.md'), 201));
    }
    if (path === `${BASE}/reindex`) {
      return Promise.resolve(json({ reindexing: true }, 202));
    }
    if (path === `${BASE}/status`) return Promise.resolve(json(world.status));
    if (path === `${BASE}/query`) {
      return Promise.resolve(
        json(
          url.searchParams.get('q') === 'nothing'
            ? []
            : [
                {
                  id: 'k1',
                  documentPath: 'acme/knowledge/shared/policy.md',
                  chunkIndex: 0,
                  content: 'Refunds within 30 days.',
                  similarity: 0.812,
                },
              ],
        ),
      );
    }
    return Promise.reject(new Error(`unexpected ${method} ${path}`));
  });
};

const renderPanel = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <main>
        <KnowledgePanel
          companyId="c1"
          scope={{ kind: 'company', companyId: 'c1' }}
          folder="knowledge/shared/"
          headingLevel={2}
        />
      </main>
    </QueryClientProvider>,
  );

describe('KnowledgePanel', () => {
  let world: World;

  beforeEach(() => {
    installFetchMock();
    calls.length = 0;
    vi.mocked(announce).mockClear();
    world = { docs: [doc('handbook.md'), doc('policy.md')], status: status() };
    serve(world);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the scope’s documents in a storage browser rooted at its folder, with the index status', async () => {
    renderPanel();
    expect(
      await screen.findByRole('row', { name: /handbook\.md/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('treegrid', { name: t('knowledge.headingShared') }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(new RegExp(tCount('knowledge.status.chunks', 7))),
    ).toBeInTheDocument();
    expect(calls).toContain(
      'GET /api/company/c1/storage/folder?path=knowledge%2Fshared%2F',
    );
    await expectNoA11yViolations(document.body);
  });

  it('uploads through the knowledge route after confirming, and the status follows the rebuild', async () => {
    const user = userEvent.setup();
    const { container } = renderPanel();
    await screen.findByRole('row', { name: /handbook\.md/ });

    const input = container.querySelector(
      'input[type="file"]:not([webkitdirectory])',
    );
    if (!(input instanceof HTMLInputElement)) throw new Error('no file input');
    await user.upload(input, [new File(['# New'], 'new.md')]);
    const dialog = await screen.findByRole('alertdialog');
    await user.click(
      within(dialog).getByRole('button', { name: t('storage.door.confirm') }),
    );

    await waitFor(() => expect(calls).toContain(`POST ${BASE}`));
    expect(
      await screen.findByText(new RegExp(t('knowledge.status.indexing'))),
    ).toBeInTheDocument();
  });

  it('polls while indexing, and announces when the index is ready', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    world.status = status({ indexing: true });
    renderPanel();
    expect(
      await screen.findByText(new RegExp(t('knowledge.status.indexing'))),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: t('knowledge.rebuild') }),
    ).toBeDisabled();

    world.status = status({ indexing: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    await waitFor(() =>
      expect(announce).toHaveBeenCalledWith({
        channel: 'knowledge',
        change: 'knowledge.announce.ready',
      }),
    );
    expect(
      screen.getByRole('button', { name: t('knowledge.rebuild') }),
    ).toBeEnabled();
  });

  it('announces a failed rebuild, and shows why', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    world.status = status({ indexing: true });
    renderPanel();
    await screen.findByText(new RegExp(t('knowledge.status.indexing')));

    world.status = status({ indexing: false, lastError: 'embedding down' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    await waitFor(() =>
      expect(announce).toHaveBeenCalledWith({
        channel: 'knowledge',
        change: 'knowledge.announce.failed',
      }),
    );
    expect(
      screen.getByText(
        t('knowledge.status.error', { message: 'embedding down' }),
      ),
    ).toBeInTheDocument();
  });

  it('rebuilds on request, and refreshes the status on request', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByRole('row', { name: /handbook\.md/ });

    await user.click(
      screen.getByRole('button', { name: t('knowledge.rebuild') }),
    );
    expect(calls).toContain(`POST ${BASE}/reindex`);

    const before = calls.filter((c) => c.endsWith('/status')).length;
    await user.click(
      screen.getByRole('button', { name: t('knowledge.refresh') }),
    );
    await waitFor(() =>
      expect(calls.filter((c) => c.endsWith('/status')).length).toBeGreaterThan(
        before,
      ),
    );
  });

  it('searches the knowledge and shows each passage with its source and match', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByRole('row', { name: /handbook\.md/ });

    await user.type(
      screen.getByRole('textbox', { name: t('knowledge.query.label') }),
      'refunds',
    );
    await user.click(
      screen.getByRole('button', { name: t('knowledge.query.submit') }),
    );

    const results = await screen.findByRole('table', {
      name: t('knowledge.query.results', { q: 'refunds' }),
    });
    expect(within(results).getByText('policy.md')).toBeInTheDocument();
    expect(within(results).getByText('81%')).toBeInTheDocument();
    expect(
      within(results).getByText('Refunds within 30 days.'),
    ).toBeInTheDocument();
    expect(calls).toContain(`GET ${BASE}/query?q=refunds`);
  });

  it('says so when no passage matches', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByRole('row', { name: /handbook\.md/ });

    await user.type(
      screen.getByRole('textbox', { name: t('knowledge.query.label') }),
      'nothing',
    );
    await user.click(
      screen.getByRole('button', { name: t('knowledge.query.submit') }),
    );
    expect(
      await screen.findByText(t('knowledge.query.none', { q: 'nothing' })),
    ).toBeInTheDocument();
  });
});
