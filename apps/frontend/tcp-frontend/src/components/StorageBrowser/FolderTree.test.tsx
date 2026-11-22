import { StrictMode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageFolderDTO } from '../../api/hooks';
import { t } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import { fetchMock, installFetchMock } from '../../test-support/fetch-mock';
import { FolderTree } from './FolderTree';

const BASE = '/api/company/c1/storage';

/** A listing of `path`: its subfolders (with purposes) and one file. */
const folder = (
  path: string,
  folders: readonly (readonly [string, string | null])[],
): StorageFolderDTO => ({
  path,
  writable: true,
  folders: folders.map(([name, purpose]) => ({
    path: `${path}${name}/`,
    name,
    purpose,
  })),
  files: [
    {
      path: `${path}README.md`,
      name: 'README.md',
      size: 12,
      lastModified: '2026-11-01T09:00:00Z',
    },
  ],
});

/** The storage the fake server holds, by folder path; a missing path fails. */
const FOLDERS: Record<string, StorageFolderDTO> = {
  'resources/': folder('resources/', [
    ['pricing', 'Price lists'],
    ['policies', null],
  ]),
  'resources/pricing/': folder('resources/pricing/', [['2026', null]]),
};

/** Every folder listed, by its `path` query. */
let listed: string[] = [];

const serve = () => {
  fetchMock.mockImplementation((input) => {
    const url = new URL(
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input,
    );
    if (url.pathname !== `${BASE}/folder`) {
      return Promise.reject(new Error(`unexpected ${url.pathname}`));
    }
    const path = url.searchParams.get('path') ?? '';
    listed.push(path);
    const listing = FOLDERS[path];
    return Promise.resolve(
      new Response(JSON.stringify(listing ?? { message: 'no' }), {
        status: listing === undefined ? 500 : 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
};

const renderTree = (props: Partial<Parameters<typeof FolderTree>[0]> = {}) =>
  render(
    <StrictMode>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <main>
          <FolderTree
            companyId="c1"
            root="resources/"
            label="Company resources"
            {...props}
          />
        </main>
      </QueryClientProvider>
    </StrictMode>,
  );

const row = (name: RegExp | string) => screen.findByRole('row', { name });

describe('FolderTree', () => {
  beforeEach(() => {
    installFetchMock();
    listed = [];
    serve();
  });

  it('lists folders only when asked to, hiding the files', async () => {
    renderTree({ foldersOnly: true });
    await row(/pricing/);
    expect(screen.queryByRole('row', { name: /README/ })).toBeNull();
  });

  it('lists files too by default', async () => {
    renderTree();
    expect(await row(/README\.md/)).toBeInTheDocument();
  });

  it('reads a purpose as part of its folder, set apart from the name', async () => {
    renderTree({ foldersOnly: true });
    expect(await row('pricing, Price lists')).toBeInTheDocument();
    expect(await row('policies')).toBeInTheDocument();
  });

  it('opens a folder on a click, with its name and purpose', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    renderTree({ foldersOnly: true, onOpen });
    await user.click(await row(/pricing/));
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'resources/pricing/',
        name: 'pricing',
        purpose: 'Price lists',
      }),
    );
  });

  it('opens a folder with Enter, and expands one with the arrow keys, fetching it then', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    renderTree({ foldersOnly: true, onOpen });
    const pricing = await row(/pricing/);
    expect(listed).not.toContain('resources/pricing/');

    expect(pricing).toHaveAttribute('aria-expanded', 'false');
    await user.tab();
    expect(pricing).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(pricing).toHaveAttribute('aria-expanded', 'true');
    expect(await row(/2026/)).toBeInTheDocument();
    expect(listed).toContain('resources/pricing/');
    expect(onOpen).not.toHaveBeenCalled();

    await user.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'resources/pricing/' }),
    );
  });

  it('selects nothing when it opens folders', async () => {
    const user = userEvent.setup();
    renderTree({ foldersOnly: true, onOpen: vi.fn() });
    const pricing = await row(/pricing/);
    await user.click(pricing);
    expect(pricing).not.toHaveAttribute('aria-selected', 'true');
  });

  it('shows a failed listing as a row that says so', async () => {
    renderTree({ root: 'missing/' });
    expect(await row(t('storage.error'))).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('has no accessibility violations', async () => {
    const { container } = renderTree({ foldersOnly: true, onOpen: vi.fn() });
    const pricing = await row(/pricing/);
    expect(within(pricing).getAllByRole('button')).toHaveLength(1);
    await expectNoA11yViolations(container);
  });
});
