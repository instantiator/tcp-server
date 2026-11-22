import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { announce } from '../../announce/announcer';
import type { UploadDoor } from '../../api/hooks';
import { fetchMock, installFetchMock } from '../../test-support/fetch-mock';
import { useUploads, type UploadItem } from './useUploads';

vi.mock('../../announce/announcer', async (original) => ({
  ...(await original<typeof import('../../announce/announcer')>()),
  announce: vi.fn(),
}));

const ROLE_DOOR: UploadDoor = {
  kind: 'knowledge',
  scope: { kind: 'role', roleId: 'role-1' },
};
const MATERIALS_DOOR: UploadDoor = { kind: 'materials', taskId: 't-1' };

const item = (path: string): UploadItem => ({
  path,
  file: new File(['text'], path.split('/').pop() ?? path),
});

const json = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );

/** Answers the folder listing with `existing`, and every upload with `status`. */
const answer = (existing: readonly string[], status = 201) => {
  fetchMock.mockImplementation((input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/storage/folder')) {
      return json(200, {
        path: 'knowledge/writer/',
        writable: false,
        folders: [],
        files: existing.map((name) => ({
          path: `knowledge/writer/${name}`,
          name,
          size: 1,
          lastModified: '2026-11-01T09:00:00Z',
        })),
      });
    }
    return json(status, status < 300 ? {} : { message: 'Task is not ready' });
  });
};

/** The uploads sent, as their URL path and the multipart fields they carried. */
const uploadsSent = () =>
  fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([input, init]) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = init?.body;
      const fields =
        body instanceof FormData
          ? [...body.keys()].filter((key) => key !== 'file')
          : [];
      const filename = body instanceof FormData ? body.get('filename') : null;
      return { path: new URL(url).pathname, fields, filename };
    });

const renderUploads = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useUploads('company-1'), { wrapper });
};

describe('useUploads through a door', () => {
  beforeEach(() => {
    installFetchMock();
    vi.mocked(announce).mockClear();
  });

  it("posts knowledge to the role's route, and says so once", async () => {
    answer([]);
    const { result } = renderUploads();
    await act(() =>
      result.current.start(
        [item('knowledge/writer/a.txt'), item('knowledge/writer/b.md')],
        'knowledge/writer/',
        'knowledge/writer/',
        ROLE_DOOR,
      ),
    );
    expect(uploadsSent()).toEqual([
      { path: '/api/role/role-1/knowledge', fields: [], filename: null },
      { path: '/api/role/role-1/knowledge', fields: [], filename: null },
    ]);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(
      expect.objectContaining({ change: 'storage.uploaded' }),
    );
  });

  it('asks "Replace?" for a name its conversion would take, then sends that name', async () => {
    answer(['report.md']);
    const { result } = renderUploads();
    await act(() =>
      result.current.start(
        [item('knowledge/writer/report.docx')],
        'knowledge/writer/',
        'knowledge/writer/',
        ROLE_DOOR,
      ),
    );
    expect(uploadsSent()).toEqual([]);
    expect(result.current.clashes?.items.map((i) => i.path)).toEqual([
      'knowledge/writer/report.docx',
    ]);

    await act(() => result.current.replace());
    expect(uploadsSent()).toEqual([
      {
        path: '/api/role/role-1/knowledge',
        fields: ['filename'],
        filename: 'report.md',
      },
    ]);
  });

  it('lists a materials 409 as a failure, not a clash', async () => {
    answer([], 409);
    const { result } = renderUploads();
    await act(() =>
      result.current.start(
        [item('tasks/t-1/materials/brief.pdf')],
        'tasks/t-1/materials/',
        'tasks/t-1/materials/',
        MATERIALS_DOOR,
      ),
    );
    expect(uploadsSent().map((u) => u.path)).toEqual([
      '/api/task/t-1/materials',
    ]);
    expect(result.current.clashes).toBeNull();
    expect(result.current.failures).toEqual([
      { name: 'brief.pdf', reason: 'Task is not ready' },
    ]);
    expect(announce).toHaveBeenCalledWith(
      expect.objectContaining({ change: 'storage.uploadFailed' }),
    );
  });

  it('refuses a file inside a dropped folder, and sends the rest', async () => {
    answer([]);
    const { result } = renderUploads();
    await act(() =>
      result.current.start(
        [
          item('knowledge/writer/top.md'),
          item('knowledge/writer/drafts/deep.md'),
        ],
        'knowledge/writer/',
        'knowledge/writer/',
        ROLE_DOOR,
      ),
    );
    expect(uploadsSent()).toHaveLength(1);
    expect(result.current.failures.map((f) => f.name)).toEqual([
      'drafts/deep.md',
    ]);
  });
});
