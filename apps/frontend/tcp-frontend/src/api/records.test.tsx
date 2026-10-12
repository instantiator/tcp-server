import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { recordsDownloadName } from '@tcp/shared/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleUnauthorized } from '../auth/unauthorized';
import {
  fetchMock,
  installFetchMock,
  requestedUrls,
  respondByRoute,
} from '../test-support/fetch-mock';

import { getBlob } from './client';
import type { RecordTableRows, TimedRecord } from './dtos';
import { ApiError } from './errors';
import {
  downloadAllRecordTables,
  downloadRecordSelection,
  downloadRecordTableCsv,
  recordErrorBody,
  useAddDoNotStore,
  useAddRecord,
  useAppendRecordsCsv,
  useClearRecordTable,
  useDeleteRecord,
  useDeleteRecords,
  useDoNotStoreList,
  useDropRecordTable,
  useRecordSearch,
  useRecordTable,
  useRecordTables,
  useReloadRecordTable,
  useSetRetention,
  useUpdateRecord,
} from './hooks';
import { queryKeys } from './query-keys';

vi.mock('../auth/unauthorized', () => ({ handleUnauthorized: vi.fn() }));

window.__TCP_CONFIG__ = {
  oidcIssuerUrl: 'https://idp.example.com',
  oidcClientId: 'test-web-client',
};

const C = 'company-1';
const T = 'orders';
const BASE = `/api/company/${C}/records`;
const NOW = '2026-08-09T00:00:00.000Z';

const row = (id: string, version = 1, data = {}): TimedRecord => ({
  id,
  version,
  data,
  createdAt: NOW,
  updatedAt: NOW,
});

const tableOf = (rows: TimedRecord[]): RecordTableRows => ({
  definition: {
    id: 'd',
    name: T,
    purpose: '',
    uniqueKeys: [],
    primaryKey: [],
    schema: { properties: {} },
    retention: null,
  },
  rows,
  total: rows.length,
  truncated: false,
});

const setup = <T,>(callback: () => T) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const spy = vi.spyOn(queryClient, 'invalidateQueries');
  return {
    queryClient,
    spy,
    ...renderHook(callback, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    }),
  };
};

/** The method and URL path of the nth request. */
const call = (n = 0) => {
  const request = fetchMock.mock.calls[n]?.[0];
  if (!(request instanceof Request)) throw new Error('no request');
  return request;
};

const invalidatedKeys = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map(([filters]) =>
    typeof filters === 'object' && filters !== null && 'queryKey' in filters
      ? filters.queryKey
      : undefined,
  );

describe('record queries', () => {
  beforeEach(installFetchMock);

  it('lists the tables', async () => {
    respondByRoute([[/records\/tables$/, { body: [] }]]);
    const { result } = setup(() => useRecordTables(C));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requestedUrls()[0]).toContain(`${BASE}/tables`);
  });

  it('reads one table, and makes no request without one', async () => {
    respondByRoute([[/tables\/orders$/, { body: tableOf([]) }]]);
    const idle = setup(() => useRecordTable(C, null));
    expect(idle.result.current.fetchStatus).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();

    const { result, queryClient } = setup(() => useRecordTable(C, T));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requestedUrls()[0]).toContain(`${BASE}/tables/${T}`);
    expect(
      queryClient
        .getQueryCache()
        .find({ queryKey: queryKeys.recordTable(C, T) })?.observers[0]?.options
        .refetchOnWindowFocus,
    ).toBe(false);
  });
});

describe('record mutations that patch the cache', () => {
  beforeEach(installFetchMock);

  it('add puts the row first and raises total', async () => {
    respondByRoute([[/rows$/, { status: 201, body: row('new') }]]);
    const { result, queryClient, spy } = setup(() => useAddRecord(C, T));
    queryClient.setQueryData(queryKeys.recordTable(C, T), tableOf([row('a')]));
    await act(() => result.current.mutateAsync({ data: { x: 1 } }));
    expect(call().method).toBe('POST');
    expect(new URL(call().url).pathname).toBe(`${BASE}/tables/${T}/rows`);
    expect(await call().clone().json()).toEqual({ data: { x: 1 } });
    const cached = queryClient.getQueryData<RecordTableRows>(
      queryKeys.recordTable(C, T),
    );
    expect(cached?.rows.map((r) => r.id)).toEqual(['new', 'a']);
    expect(cached?.total).toBe(2);
    expect(invalidatedKeys(spy)).toEqual([queryKeys.recordTables(C)]);
  });

  it('update replaces the row in place', async () => {
    respondByRoute([[/rows\/b$/, { body: row('b', 2, { x: 9 }) }]]);
    const { result, queryClient, spy } = setup(() => useUpdateRecord(C, T));
    queryClient.setQueryData(
      queryKeys.recordTable(C, T),
      tableOf([row('a'), row('b'), row('c')]),
    );
    await act(() =>
      result.current.mutateAsync({ id: 'b', changes: { x: 9 }, version: 1 }),
    );
    expect(call().method).toBe('PATCH');
    expect(await call().clone().json()).toEqual({
      changes: { x: 9 },
      version: 1,
    });
    const cached = queryClient.getQueryData<RecordTableRows>(
      queryKeys.recordTable(C, T),
    );
    expect(cached?.rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(cached?.rows[1]?.version).toBe(2);
    expect(invalidatedKeys(spy)).toEqual([queryKeys.recordTables(C)]);
  });

  it('delete removes the row and lowers total', async () => {
    respondByRoute([[/rows\/a/, { status: 204, body: undefined }]]);
    const { result, queryClient, spy } = setup(() => useDeleteRecord(C, T));
    queryClient.setQueryData(
      queryKeys.recordTable(C, T),
      tableOf([row('a'), row('b')]),
    );
    await act(() => result.current.mutateAsync({ id: 'a', version: 3 }));
    expect(call().method).toBe('DELETE');
    expect(new URL(call().url).searchParams.get('version')).toBe('3');
    const cached = queryClient.getQueryData<RecordTableRows>(
      queryKeys.recordTable(C, T),
    );
    expect(cached?.rows.map((r) => r.id)).toEqual(['b']);
    expect(cached?.total).toBe(1);
    expect(invalidatedKeys(spy)).toEqual([queryKeys.recordTables(C)]);
  });

  it('a stale update exposes status and code, and reloads the table', async () => {
    respondByRoute([
      [/rows\/a$/, { status: 409, body: { message: 'moved', code: 'stale' } }],
    ]);
    const { result, spy } = setup(() => useUpdateRecord(C, T));
    await act(async () => {
      await result.current
        .mutateAsync({ id: 'a', changes: {}, version: 1 })
        .catch(() => undefined);
    });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    const error = result.current.error;
    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) return;
    expect(error.status).toBe(409);
    expect(recordErrorBody(error).code).toBe('stale');
    expect(invalidatedKeys(spy)).toEqual([
      queryKeys.recordTable(C, T),
      queryKeys.recordTables(C),
    ]);
  });

  it('a conflicting add exposes the existing recordId', async () => {
    respondByRoute([
      [
        /rows$/,
        {
          status: 409,
          body: { message: 'dup', code: 'conflict', recordId: 'r1' },
        },
      ],
    ]);
    const { result } = setup(() => useAddRecord(C, T));
    await act(async () => {
      await result.current.mutateAsync({ data: {} }).catch(() => undefined);
    });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    const error = result.current.error;
    if (!(error instanceof ApiError)) throw new Error(String(error));
    expect(recordErrorBody(error)).toMatchObject({
      code: 'conflict',
      recordId: 'r1',
    });
  });

  it('reload invalidates the open table', () => {
    const { result, spy } = setup(() => useReloadRecordTable(C, T));
    result.current();
    expect(invalidatedKeys(spy)).toContainEqual(queryKeys.recordTable(C, T));
  });
});

describe('record bulk mutations', () => {
  beforeEach(installFetchMock);

  it('csv upload posts the file and invalidates the entity', async () => {
    respondByRoute([
      [/csv$/, { status: 201, body: { inserted: 2, alreadyExists: 1 } }],
    ]);
    const { result, spy } = setup(() => useAppendRecordsCsv(C, T));
    const out = await act(() =>
      result.current.mutateAsync({ file: new File(['a,b'], 'x.csv') }),
    );
    expect(out).toEqual({ inserted: 2, alreadyExists: 1 });
    // postFile calls fetch(URL, init), not with a Request.
    const [target, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
    expect(new URL(target instanceof URL ? target.href : '').pathname).toBe(
      `${BASE}/tables/${T}/csv`,
    );
    expect(invalidatedKeys(spy)).toEqual([['record']]);
  });

  it('a bad csv exposes errors[] and still invalidates', async () => {
    respondByRoute([
      [
        /csv$/,
        {
          status: 400,
          body: { message: 'bad', errors: [{ row: 3, message: 'nope' }] },
        },
      ],
    ]);
    const { result, spy } = setup(() => useAppendRecordsCsv(C, T));
    await act(async () => {
      await result.current
        .mutateAsync({ file: new File(['a'], 'x.csv') })
        .catch(() => undefined);
    });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    const error = result.current.error;
    if (!(error instanceof ApiError)) throw new Error(String(error));
    expect(error.status).toBe(400);
    expect(recordErrorBody(error).errors).toEqual([
      { row: 3, message: 'nope' },
    ]);
    expect(invalidatedKeys(spy)).toEqual([['record']]);
  });

  it.each([
    ['clear', useClearRecordTable, `${BASE}/tables/${T}/rows`],
    ['drop', useDropRecordTable, `${BASE}/tables/${T}`],
  ])('%s sends DELETE and invalidates the entity', async (_n, hook, path) => {
    respondByRoute([[/records/, { body: { removed: 4 } }]]);
    const { result, spy } = setup(() => hook(C, T));
    await act(() => result.current.mutateAsync());
    expect(call().method).toBe('DELETE');
    expect(new URL(call().url).pathname).toBe(path);
    expect(invalidatedKeys(spy)).toEqual([['record']]);
  });
});

describe('getBlob and downloads', () => {
  beforeEach(() => {
    installFetchMock();
    vi.mocked(handleUnauthorized).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('applies the 401 policy', async () => {
    respondByRoute([
      [/.*/, { status: 401, body: { message: 'Unauthorized' } }],
    ]);
    await expect(getBlob(`${BASE}/export`)).rejects.toBeInstanceOf(ApiError);
    expect(handleUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('saves a table csv under the browser-made name, then revokes the URL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 11, 14, 5, 9));
    fetchMock.mockResolvedValueOnce(new Response('a,b', { status: 200 }));
    const create = vi.fn(() => 'blob:x');
    const revoke = vi.fn();
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: create,
        revokeObjectURL: revoke,
      }),
    );
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        expect(this.download).toBe(
          recordsDownloadName(
            'acme',
            T,
            'csv',
            new Date(2026, 9, 11, 14, 5, 9),
          ),
        );
      });
    await downloadRecordTableCsv(C, 'acme', T);
    expect(new URL(requestedUrls()[0] ?? '').pathname).toBe(
      `${BASE}/tables/${T}/csv`,
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith('blob:x');
  });

  it('downloads every table as a zip from the export route', async () => {
    fetchMock.mockResolvedValueOnce(new Response('zip', { status: 200 }));
    URL.createObjectURL = vi.fn(() => 'blob:y');
    URL.revokeObjectURL = vi.fn();
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    await downloadAllRecordTables(C, 'acme');
    expect(new URL(requestedUrls()[0] ?? '').pathname).toBe(`${BASE}/export`);
    expect(names[0]).toMatch(/ acme tables\.zip$/);
  });
});

describe('data protection (001.04)', () => {
  beforeEach(installFetchMock);

  it('sends confirmDoNotStore only when the person confirmed', async () => {
    respondByRoute([[/rows/, { status: 201, body: row('new') }]]);
    const { result } = setup(() => useAddRecord(C, T));
    await act(() => result.current.mutateAsync({ data: { x: 1 } }));
    await act(() =>
      result.current.mutateAsync({ data: { x: 1 }, confirmDoNotStore: true }),
    );
    expect(new URL(call(0).url).searchParams.has('confirmDoNotStore')).toBe(
      false,
    );
    expect(new URL(call(1).url).searchParams.get('confirmDoNotStore')).toBe(
      'true',
    );
  });

  it('reads the fields a do_not_store refusal names', async () => {
    respondByRoute([
      [
        /rows$/,
        {
          status: 409,
          body: { code: 'do_not_store', fields: ['name', 7], message: 'x' },
        },
      ],
    ]);
    const { result } = setup(() => useAddRecord(C, T));
    await act(async () => {
      await result.current.mutateAsync({ data: {} }).catch(() => undefined);
    });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    const error = result.current.error;
    if (!(error instanceof ApiError)) throw new Error('expected ApiError');
    expect(recordErrorBody(error)).toMatchObject({
      code: 'do_not_store',
      fields: ['name'],
    });
  });

  it('searches with a POST, keeping the text out of the URL, and idles when empty', async () => {
    respondByRoute([[/search$/, { body: { groups: [], truncated: false } }]]);
    const idle = setup(() => useRecordSearch(C, ''));
    expect(idle.result.current.fetchStatus).toBe('idle');

    const { result } = setup(() => useRecordSearch(C, 'Ann Lee'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(call().method).toBe('POST');
    expect(call().url).not.toContain('Ann');
    expect(await call().clone().json()).toEqual({ q: 'Ann Lee' });
  });

  it('bulk delete removes the rows where they stand and reloads searches', async () => {
    respondByRoute([[/rows\/delete$/, { body: { removed: 2 } }]]);
    const { result, queryClient, spy } = setup(() => useDeleteRecords(C, T));
    queryClient.setQueryData(
      queryKeys.recordTable(C, T),
      tableOf([row('a'), row('b'), row('c')]),
    );
    await act(() =>
      result.current.mutateAsync([
        { id: 'a', version: 1 },
        { id: 'c', version: 1 },
      ]),
    );
    expect(await call().clone().json()).toEqual({
      rows: [
        { id: 'a', version: 1 },
        { id: 'c', version: 1 },
      ],
    });
    const cached = queryClient.getQueryData<RecordTableRows>(
      queryKeys.recordTable(C, T),
    );
    expect(cached?.rows.map((r) => r.id)).toEqual(['b']);
    expect(cached?.total).toBe(1);
    expect(invalidatedKeys(spy)).toContainEqual(['record', 'search']);
  });

  it('setting retention updates the cached definition', async () => {
    const definition = {
      ...tableOf([]).definition,
      retention: { days: 30, from: 'updated' },
    };
    respondByRoute([[/retention$/, { body: definition }]]);
    const { result, queryClient } = setup(() => useSetRetention(C, T));
    queryClient.setQueryData(queryKeys.recordTable(C, T), tableOf([row('a')]));
    await act(() => result.current.mutateAsync({ days: 30, from: 'updated' }));
    expect(call().method).toBe('PUT');
    expect(
      queryClient.getQueryData<RecordTableRows>(queryKeys.recordTable(C, T))
        ?.definition.retention,
    ).toEqual({ days: 30, from: 'updated' });
  });

  it('adding to the do-not-store list reloads the list', async () => {
    respondByRoute([[/do-not-store$/, { status: 201, body: { id: 'e1' } }]]);
    const { result, spy } = setup(() => useAddDoNotStore(C));
    await act(() => result.current.mutateAsync({ value: 'Ann Lee' }));
    expect(invalidatedKeys(spy)).toContainEqual(queryKeys.doNotStore(C));
  });

  it('lists the do-not-store list', async () => {
    respondByRoute([[/do-not-store$/, { body: [] }]]);
    const { result } = setup(() => useDoNotStoreList(C));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(new URL(call().url).pathname).toBe(`${BASE}/do-not-store`);
  });

  describe('downloading a selection', () => {
    afterEach(() => vi.unstubAllGlobals());

    it.each([
      [{ orders: ['a'] }, / acme orders\.csv$/],
      [{ orders: ['a'], stock: 'all' as const }, / acme tables\.zip$/],
    ])(
      'posts the selection, and names the file for what comes back',
      async (tables, name) => {
        fetchMock.mockResolvedValueOnce(new Response('x', { status: 200 }));
        URL.createObjectURL = vi.fn(() => 'blob:z');
        URL.revokeObjectURL = vi.fn();
        const names: string[] = [];
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
          function (this: HTMLAnchorElement) {
            names.push(this.download);
          },
        );
        await downloadRecordSelection(C, 'acme', tables);
        // `send` calls fetch with a URL and init, not a Request.
        const [url, init] = fetchMock.mock.calls[0] ?? [];
        expect(url instanceof URL ? url.pathname : url).toBe(`${BASE}/export`);
        expect(init?.method).toBe('POST');
        expect(new Headers(init?.headers).get('Content-Type')).toBe(
          'application/json',
        );
        const body = init?.body;
        expect(typeof body === 'string' ? JSON.parse(body) : body).toEqual({
          tables,
        });
        expect(names[0]).toMatch(name);
      },
    );
  });
});
