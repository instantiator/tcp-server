import { StrictMode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DirectoryDropItem, FileDropItem } from 'react-aria-components';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { announce } from '../../announce/announcer';
import type { StorageFolderDTO } from '../../api/hooks';
import { t } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import { fetchMock, installFetchMock } from '../../test-support/fetch-mock';
import { StorageBrowser } from './StorageBrowser';
import { itemsFromDrop } from './useUploads';

vi.mock('../../announce/announcer', async (original) => ({
  ...(await original<typeof import('../../announce/announcer')>()),
  announce: vi.fn(),
}));

const BASE = '/api/company/c1/storage';
const LATER = '2026-10-12T14:02:00Z';
const EARLIER = '2026-10-03T09:15:00Z';

const folder = (
  path: string,
  folders: string[],
  files: string[] = [],
  purpose: string | null = null,
): StorageFolderDTO => ({
  path,
  writable: path.startsWith('resources/'),
  folders: folders.map((f) => ({
    path: `${path}${f}/`,
    name: f,
    purpose: f === 'pricing' ? purpose : null,
  })),
  files: files.map((f) => ({
    path: `${path}${f}`,
    name: f,
    size: 12,
    lastModified: LATER,
  })),
});

/** The storage the fake server holds, by folder path. */
const FOLDERS: Record<string, StorageFolderDTO> = {
  '': folder('', ['knowledge', 'resources', 'tasks']),
  'resources/': folder('resources/', ['pricing'], ['notes.md'], 'Price lists'),
  'resources/pricing/': folder('resources/pricing/', [], ['tea.md', 'b.md']),
  'knowledge/': folder('knowledge/', [], ['policy.md']),
  'tasks/': folder('tasks/', ['t1']),
  'tasks/t1/': folder('tasks/t1/', ['completed']),
  'tasks/t1/completed/': folder('tasks/t1/completed/', [], ['out.md']),
};

const json = (body: unknown, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** Every request as `METHOD path?query`. */
let calls: string[] = [];
/** How uploads answer, by file path: a status (201 by default). */
let uploadStatus: Record<string, number> = {};

/** A fake server answering by method and path, as the real routes do. */
const serve = () => {
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
    const path = url.searchParams.get('path') ?? '';

    if (url.pathname === `${BASE}/folder`) {
      const listing = FOLDERS[path];
      return Promise.resolve(
        listing === undefined ? json({ message: 'no' }, 404) : json(listing),
      );
    }
    if (url.pathname === `${BASE}/file` && method === 'GET') {
      return Promise.resolve(new Response('# Tea\n\nStrong.', { status: 200 }));
    }
    if (url.pathname === `${BASE}/file` && method === 'POST') {
      const overwrite = url.searchParams.get('overwrite') === 'true';
      const status = overwrite ? 201 : (uploadStatus[path] ?? 201);
      return Promise.resolve(
        json(status === 201 ? { path } : { message: 'exists' }, status),
      );
    }
    if (url.pathname === BASE && method === 'DELETE') {
      return Promise.resolve(json(undefined, 204));
    }
    if (url.pathname === `${BASE}/versions`) {
      return Promise.resolve(
        json([
          { versionId: 'v2', size: 12, lastModified: LATER, isLatest: true },
          { versionId: 'v1', size: 9, lastModified: EARLIER, isLatest: false },
        ]),
      );
    }
    if (url.pathname === `${BASE}/restore`) {
      return Promise.resolve(json({ path: 'resources/notes.md' }, 201));
    }
    return Promise.reject(new Error(`unexpected ${method} ${url.pathname}`));
  });
};

const renderBrowser = (
  root = '',
  folderLabel?: (path: string) => string | undefined,
) =>
  render(
    <StrictMode>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <main>
          <StorageBrowser
            companyId="c1"
            root={root}
            label="Documents"
            folderLabel={folderLabel}
          />
        </main>
      </QueryClientProvider>
    </StrictMode>,
  );

const row = (name: RegExp | string) => screen.findByRole('row', { name });

/** Expands a folder row with its chevron, as a pointer user would. */
const expand = async (
  user: ReturnType<typeof userEvent.setup>,
  name: RegExp,
) => {
  const folderRow = await row(name);
  await user.click(within(folderRow).getAllByRole('button')[0]);
};

const toolbarButton = (name: string) =>
  within(screen.getByRole('toolbar')).getByRole('button', { name });

/** The hidden file input behind "Upload files". */
const filesInput = (container: HTMLElement) => {
  const input = container.querySelector(
    'input[type="file"]:not([webkitdirectory])',
  );
  if (!(input instanceof HTMLInputElement)) throw new Error('no file input');
  return input;
};

describe('StorageBrowser', () => {
  beforeEach(() => {
    installFetchMock();
    vi.mocked(announce).mockClear();
    calls = [];
    uploadStatus = {};
    serve();
  });

  it('lists the root, and fetches a folder only when it is expanded', async () => {
    const user = userEvent.setup();
    renderBrowser();
    await row(/resources/);
    expect(calls).not.toContain(
      'GET /api/company/c1/storage/folder?path=resources%2F',
    );

    await expand(user, /resources/);
    expect(await row(/pricing/)).toHaveTextContent('Price lists');
    expect(calls).toContain(
      'GET /api/company/c1/storage/folder?path=resources%2F',
    );
  });

  it('never shows or asks for anything above its root', async () => {
    renderBrowser('tasks/t1/');
    await row(/completed/);
    expect(screen.queryByRole('row', { name: /resources/ })).toBeNull();
    for (const call of calls) {
      expect(call).toMatch(/path=tasks%2Ft1%2F/);
    }
  });

  it('shows a folder by the friendlier name it is given', async () => {
    const user = userEvent.setup();
    renderBrowser('', (path) =>
      path === 'tasks/t1/' ? 'T-1 · Restock tea' : undefined,
    );
    await expand(user, /tasks/);
    expect(await row(/T-1 · Restock tea/)).toBeInTheDocument();
  });

  it('previews one selected file, and none when two are selected', async () => {
    const user = userEvent.setup();
    renderBrowser();
    await expand(user, /resources/);
    await expand(user, /pricing/);

    await user.click(await row(/tea\.md/));
    const preview = await screen.findByRole('region', { name: 'tea.md' });
    expect(
      await within(preview).findByRole('heading', { name: 'Tea' }),
    ).toBeInTheDocument();

    await user.click(await row(/b\.md/));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'tea.md' })).toBeNull(),
    );
    expect(screen.getByRole('toolbar')).toHaveTextContent('2 selected');
  });

  it('allows uploads and deletes only under resources/', async () => {
    const user = userEvent.setup();
    renderBrowser();
    await row(/knowledge/);
    expect(toolbarButton(t('storage.uploadFiles'))).toBeDisabled();

    await user.click(await row(/knowledge/));
    expect(toolbarButton(t('storage.uploadFiles'))).toBeDisabled();
    expect(toolbarButton(t('storage.delete'))).toBeDisabled();

    await user.click(await row(/knowledge/));
    await user.click(await row(/resources/));
    expect(toolbarButton(t('storage.uploadFiles'))).toBeEnabled();
    // The resources folder itself can't be deleted, only what's in it.
    expect(toolbarButton(t('storage.delete'))).toBeDisabled();
  });

  it('shows no write controls in a browser rooted outside resources/', async () => {
    renderBrowser('tasks/t1/');
    await row(/completed/);
    expect(
      within(screen.getByRole('toolbar')).queryByRole('button', {
        name: t('storage.uploadFiles'),
      }),
    ).toBeNull();
    expect(screen.getByText(t('storage.readOnlyHere'))).toBeInTheDocument();
  });

  it('asks before replacing a file that exists, then overwrites it', async () => {
    const user = userEvent.setup();
    uploadStatus = { 'resources/notes.md': 409 };
    const { container } = renderBrowser();
    await user.click(await row(/resources/));

    await user.upload(filesInput(container), [
      new File(['new'], 'notes.md'),
      new File(['x'], 'fresh.md'),
    ]);
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('notes.md');
    await user.click(
      within(dialog).getByRole('button', {
        name: t('storage.replace.confirm'),
      }),
    );

    await waitFor(() =>
      expect(calls).toContain(
        'POST /api/company/c1/storage/file?path=resources%2Fnotes.md&overwrite=true',
      ),
    );
    expect(announce).toHaveBeenCalledWith(
      expect.objectContaining({
        change: 'storage.uploaded',
        params: { files: '2 files', folder: 'resources/' },
      }),
    );
  });

  it('skips a clashing file when asked to', async () => {
    const user = userEvent.setup();
    uploadStatus = { 'resources/notes.md': 409 };
    const { container } = renderBrowser();
    await user.click(await row(/resources/));

    await user.upload(filesInput(container), new File(['new'], 'notes.md'));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(
      within(dialog).getByRole('button', { name: t('storage.replace.skip') }),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(calls.filter((c) => c.includes('overwrite=true'))).toEqual([]);
    expect(announce).not.toHaveBeenCalled();
  });

  it('deletes after confirming, says so, and puts focus back on the tree', async () => {
    const user = userEvent.setup();
    renderBrowser();
    await expand(user, /resources/);
    await user.click(await row(/notes\.md/));
    await user.click(toolbarButton(t('storage.delete')));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(
      within(dialog).getByRole('button', { name: t('storage.delete') }),
    );

    await waitFor(() =>
      expect(calls).toContain(
        'DELETE /api/company/c1/storage?path=resources%2Fnotes.md',
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('treegrid').contains(document.activeElement),
      ).toBe(true),
    );
    expect(announce).toHaveBeenCalledWith(
      expect.objectContaining({
        change: 'storage.deleted',
        params: { items: '1 item' },
      }),
    );
  });

  it('restores an older version after confirming', async () => {
    const user = userEvent.setup();
    renderBrowser();
    await expand(user, /resources/);
    await user.click(await row(/notes\.md/));
    const preview = await screen.findByRole('region', { name: 'notes.md' });
    await user.click(within(preview).getByText(t('storage.history')));

    const restore = await within(preview).findByRole('button', {
      name: /Restore the version from/,
    });
    await user.click(restore);
    const dialog = await screen.findByRole('alertdialog');
    await user.click(
      within(dialog).getByRole('button', {
        name: t('storage.restore.confirm'),
      }),
    );

    await waitFor(() =>
      expect(announce).toHaveBeenCalledWith(
        expect.objectContaining({ change: 'storage.restored' }),
      ),
    );
    expect(calls).toContain('POST /api/company/c1/storage/restore');
  });

  it('has no axe violations with a folder open and a file previewed', async () => {
    const user = userEvent.setup();
    const { container } = renderBrowser();
    await expand(user, /resources/);
    await user.click(await row(/notes\.md/));
    await screen.findByRole('region', { name: 'notes.md' });
    await expectNoA11yViolations(container);
  });
});

describe('itemsFromDrop', () => {
  const fileItem = (name: string): FileDropItem => ({
    kind: 'file',
    type: 'text/plain',
    name,
    getFile: () => Promise.resolve(new File(['x'], name)),
    getText: () => Promise.resolve('x'),
  });
  const dirItem = (
    name: string,
    entries: (FileDropItem | DirectoryDropItem)[],
  ): DirectoryDropItem => ({
    kind: 'directory',
    name,
    getEntries: async function* () {
      for (const entry of entries) yield await Promise.resolve(entry);
    },
  });

  it('keeps a dropped folder’s files in their places under the target', async () => {
    const items = await itemsFromDrop(
      [
        fileItem('a.md'),
        dirItem('docs', [fileItem('b.md'), dirItem('sub', [fileItem('c.md')])]),
      ],
      'resources/',
    );
    expect(items.map((i) => i.path)).toEqual([
      'resources/a.md',
      'resources/docs/b.md',
      'resources/docs/sub/c.md',
    ]);
  });
});
