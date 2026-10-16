import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { announce } from '../../../announce/announcer';
import { t, tCount } from '../../../strings';
import { expectNoA11yViolations } from '../../../test-support/axe';
import { fetchMock, installFetchMock } from '../../../test-support/fetch-mock';
import { KnowledgePanel } from './KnowledgePanel';

vi.mock('../../../announce/announcer', () => ({ announce: vi.fn() }));

const BASE = '/api/company/c1/knowledge';

const doc = (name: string) => ({
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
  /** The answer to an upload: a status, or `'hang'` to wait for an abort. */
  upload: number | 'hang';
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

    if (method === 'POST' && path === BASE) {
      if (world.upload === 'hang') {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        });
      }
      return Promise.resolve(
        json(
          world.upload === 201
            ? doc('new.md')
            : { message: `refused with ${String(world.upload)}` },
          world.upload,
        ),
      );
    }
    if (method === 'DELETE') return Promise.resolve(json(undefined, 204));
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
    if (path === BASE) return Promise.resolve(json(world.docs));
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
          scope={{ kind: 'company', companyId: 'c1' }}
          headingLevel={2}
        />
      </main>
    </QueryClientProvider>,
  );

const uploadInput = () => screen.getByLabelText(t('knowledge.upload'));
const file = (name: string) =>
  new File(['# Title\n\nBody.'], name, { type: 'text/markdown' });

describe('KnowledgePanel', () => {
  let world: World;

  beforeEach(() => {
    installFetchMock();
    calls.length = 0;
    vi.mocked(announce).mockClear();
    world = {
      docs: [doc('handbook.md'), doc('policy.md')],
      status: status(),
      upload: 201,
    };
    serve(world);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists the documents and the index status, with the accepted types shown before picking', async () => {
    renderPanel();
    expect(
      await screen.findByRole('rowheader', { name: 'handbook.md' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(new RegExp(tCount('knowledge.status.chunks', 7))),
    ).toBeInTheDocument();
    expect(uploadInput()).toHaveAccessibleDescription(
      t('knowledge.uploadHint'),
    );
    expect(uploadInput()).toHaveAttribute(
      'accept',
      expect.stringContaining('.pdf'),
    );
    await expectNoA11yViolations(document.body);
  });

  it('uploads a document, announces it, and refreshes the list', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByRole('rowheader', { name: 'handbook.md' });

    world.docs = [...world.docs, doc('new.md')];
    await user.upload(uploadInput(), file('new.md'));

    await waitFor(() =>
      expect(announce).toHaveBeenCalledWith({
        channel: 'knowledge',
        change: 'knowledge.announce.uploaded',
        params: { name: 'new.md' },
      }),
    );
    expect(
      await screen.findByRole('rowheader', { name: 'new.md' }),
    ).toBeInTheDocument();
  });

  it('says why an upload was refused: the server message, or the size limit for 413', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByRole('rowheader', { name: 'handbook.md' });

    world.upload = 400;
    await user.upload(uploadInput(), file('bad.md'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      t('knowledge.uploadFailed', { message: 'refused with 400' }),
    );

    world.upload = 413;
    await user.upload(uploadInput(), file('big.md'));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        t('knowledge.tooLarge'),
      ),
    );
  });

  it('cancels an upload in flight, and the control comes back', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByRole('rowheader', { name: 'handbook.md' });

    world.upload = 'hang';
    await user.upload(uploadInput(), file('slow.md'));
    expect(uploadInput()).toBeDisabled();

    await user.click(
      screen.getByRole('button', { name: t('knowledge.cancelUpload') }),
    );
    await waitFor(() =>
      expect(announce).toHaveBeenCalledWith({
        channel: 'knowledge',
        change: 'knowledge.announce.cancelled',
      }),
    );
    expect(uploadInput()).toBeEnabled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('deletes after confirming, and puts focus on the next document', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByRole('rowheader', { name: 'handbook.md' });

    await user.click(
      screen.getByRole('button', {
        name: t('knowledge.delete', { name: 'handbook.md' }),
      }),
    );
    const confirm = screen.getByRole('alertdialog', {
      name: t('knowledge.deleteHeading', { name: 'handbook.md' }),
    });
    world.docs = [doc('policy.md')];
    await user.click(
      within(confirm).getByRole('button', {
        name: t('knowledge.deleteConfirm'),
      }),
    );

    expect(calls).toContain(`DELETE ${BASE}/handbook.md`);
    await waitFor(() =>
      expect(
        screen.getByRole('rowheader', { name: 'policy.md' }),
      ).toHaveFocus(),
    );
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
    await screen.findByRole('rowheader', { name: 'handbook.md' });

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
    await screen.findByRole('rowheader', { name: 'handbook.md' });

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
    await screen.findByRole('rowheader', { name: 'handbook.md' });

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
