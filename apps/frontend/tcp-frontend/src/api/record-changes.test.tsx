import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { WireEvent } from '@tcp/shared/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyEvent } from '../events/cache';
import {
  installFetchMock,
  requestedUrls,
  respondByRoute,
} from '../test-support/fetch-mock';

import type { RecordSearchResult, RecordTableRows, TimedRecord } from './dtos';
import {
  useLiveRecordSearchChanges,
  useLiveRecordTableChanges,
  useRecordSearch,
  useRecordTable,
  useReloadRecordTable,
  useUpdateRecord,
} from './hooks';
import { queryKeys } from './query-keys';
import { RECORD_CHANGE_WINDOW_MS } from './record-changes';

vi.mock('../auth/unauthorized', () => ({ handleUnauthorized: vi.fn() }));

window.__TCP_CONFIG__ = {
  oidcIssuerUrl: 'https://idp.example.com',
  oidcClientId: 'test-web-client',
};

const C = 'company-1';
const T = 'orders';
const NOW = '2026-10-15T00:00:00.000Z';

const row = (id: string, version = 1): TimedRecord => ({
  id,
  version,
  data: {},
  createdAt: NOW,
  updatedAt: NOW,
});

const definition = (name: string) => ({
  id: name,
  name,
  purpose: '',
  uniqueKeys: [],
  primaryKey: [],
  schema: { properties: {} },
  retention: null,
});

const tableOf = (rows: TimedRecord[], name = T): RecordTableRows => ({
  definition: definition(name),
  rows,
  total: rows.length,
  truncated: false,
});

/** A `record` signal as the company stream sends it. */
const recordEvent = (table?: string): WireEvent => ({
  type: 'audit',
  event: {
    timestamp: NOW,
    companyId: C,
    role: 'agent',
    agentId: null,
    assignmentId: null,
    taskId: null,
    eventType: 'state_change',
    payload: {
      entity: 'record',
      action: 'update',
      ...(table ? { table } : {}),
    },
  },
});

const newClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

/** Renders `callback` against `queryClient`. */
const render = <R,>(queryClient: QueryClient, callback: () => R) =>
  renderHook(callback, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });

/** Lets the change window close and its reads settle. */
const closeWindow = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(RECORD_CHANGE_WINDOW_MS);
  });
};

/** How many times a table's rows were read. */
const tableReads = (table: string) =>
  requestedUrls().filter((url) =>
    new URL(url).pathname.endsWith(`/records/tables/${table}`),
  ).length;

describe('record changes heard on the company stream (001.05)', () => {
  beforeEach(() => {
    installFetchMock();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => vi.useRealTimers());

  it('never refetches an open table or search, and refetches the summaries once per burst', async () => {
    respondByRoute([[/tables\/orders$/, { body: tableOf([row('a')]) }]]);
    const queryClient = newClient();
    const { result } = render(queryClient, () => useRecordTable(C, T));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    queryClient.setQueryData(queryKeys.recordTables(C), []);
    queryClient.setQueryData(queryKeys.recordSearch(C, 'Ann'), {
      groups: [],
      truncated: false,
    });
    const shown = result.current.data;
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    for (let i = 0; i < 20; i++) applyEvent(queryClient, recordEvent(T));
    await closeWindow();

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(
      queryClient.getQueryState(queryKeys.recordTables(C))?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(queryKeys.recordSearch(C, 'Ann'))
        ?.isInvalidated,
    ).toBe(false);
    // What is on screen is the same object: nothing replaced it.
    expect(result.current.data).toBe(shown);
    expect(tableReads(T)).toBe(2);
  });

  it('reads again only the tables someone has open', async () => {
    respondByRoute([[/tables\/orders$/, { body: tableOf([row('a')]) }]]);
    const queryClient = newClient();
    const { result } = render(queryClient, () => useRecordTable(C, T));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // Cached, but nothing shows it.
    queryClient.setQueryData(queryKeys.recordTable(C, 'other'), tableOf([]));

    applyEvent(queryClient, recordEvent('other'));
    await closeWindow();
    expect(tableReads('other')).toBe(0);
    expect(tableReads(T)).toBe(1);

    applyEvent(queryClient, recordEvent(T));
    await closeWindow();
    expect(tableReads(T)).toBe(2);
  });

  it('re-checks every open table after a reconnect, which names none', async () => {
    respondByRoute([
      [/tables\/orders$/, { body: tableOf([row('a')]) }],
      [/tables\/stock$/, { body: tableOf([row('s')], 'stock') }],
    ]);
    const queryClient = newClient();
    const orders = render(queryClient, () => useRecordTable(C, T));
    const stock = render(queryClient, () => useRecordTable(C, 'stock'));
    await waitFor(() => expect(orders.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(stock.result.current.isSuccess).toBe(true));

    applyEvent(queryClient, recordEvent());
    await closeWindow();
    expect(tableReads(T)).toBe(2);
    expect(tableReads('stock')).toBe(2);
  });
});

describe('useLiveRecordTableChanges (001.05)', () => {
  beforeEach(() => {
    installFetchMock();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => vi.useRealTimers());

  /** An open table and its changes, as `TableView` reads them. */
  const openTable = (queryClient: QueryClient) =>
    render(queryClient, () => {
      const shown = useRecordTable(C, T);
      return {
        shown,
        changes: useLiveRecordTableChanges(C, T, shown.data),
        update: useUpdateRecord(C, T),
        reload: useReloadRecordTable(C, T),
      };
    });

  it('says nothing has changed until a change is heard', async () => {
    respondByRoute([[/tables\/orders$/, { body: tableOf([row('a')]) }]]);
    const { result } = openTable(newClient());
    await waitFor(() => expect(result.current.shown.isSuccess).toBe(true));
    expect(result.current.changes.any).toBe(false);
  });

  it('names rows changed and deleted elsewhere, and counts those added', async () => {
    let stored = tableOf([row('a'), row('b')]);
    respondByRoute([[/tables\/orders$/, { body: stored }]]);
    const queryClient = newClient();
    const { result } = openTable(queryClient);
    await waitFor(() => expect(result.current.shown.isSuccess).toBe(true));

    stored = tableOf([row('c'), row('a', 2)]);
    respondByRoute([[/tables\/orders$/, { body: stored }]]);
    applyEvent(queryClient, recordEvent(T));
    await closeWindow();

    await waitFor(() => expect(result.current.changes.any).toBe(true));
    expect([...result.current.changes.changed]).toEqual(['a']);
    expect([...result.current.changes.deleted]).toEqual(['b']);
    expect(result.current.changes.added).toBe(1);
    expect(result.current.changes.dropped).toBe(false);
    // Rows keep their order and their old values until Reload.
    expect(result.current.shown.data?.rows.map((r) => r.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('never reports an edit made here as made elsewhere', async () => {
    respondByRoute([
      [/tables\/orders$/, { body: tableOf([row('a'), row('b')]) }],
      [/rows\/a$/, { body: row('a', 2) }],
    ]);
    const queryClient = newClient();
    const { result } = openTable(queryClient);
    await waitFor(() => expect(result.current.shown.isSuccess).toBe(true));

    // A change to 'b' elsewhere: a fresher copy is read, where 'a' is still 1.
    respondByRoute([
      [/tables\/orders$/, { body: tableOf([row('a'), row('b', 2)]) }],
      [/rows\/a$/, { body: row('a', 2) }],
    ]);
    applyEvent(queryClient, recordEvent(T));
    await closeWindow();
    await waitFor(() => expect(result.current.changes.any).toBe(true));

    // Then 'a' is edited here: both copies get version 2.
    await act(() =>
      result.current.update.mutateAsync({ id: 'a', changes: {}, version: 1 }),
    );
    expect([...result.current.changes.changed]).toEqual(['b']);
  });

  it('clears a mark once a late response brings the screen up to date', async () => {
    respondByRoute([[/tables\/orders$/, { body: tableOf([row('a')]) }]]);
    const queryClient = newClient();
    const { result } = openTable(queryClient);
    await waitFor(() => expect(result.current.shown.isSuccess).toBe(true));

    // The copy is read before this person's own save has answered.
    respondByRoute([[/tables\/orders$/, { body: tableOf([row('a', 2)]) }]]);
    applyEvent(queryClient, recordEvent(T));
    await closeWindow();
    await waitFor(() => expect(result.current.changes.any).toBe(true));

    act(() => {
      queryClient.setQueryData(
        queryKeys.recordTable(C, T),
        tableOf([row('a', 2)]),
      );
    });
    await waitFor(() => expect(result.current.changes.any).toBe(false));
  });

  it('forgets the fresher copy on Reload', async () => {
    respondByRoute([[/tables\/orders$/, { body: tableOf([row('a')]) }]]);
    const queryClient = newClient();
    const { result } = openTable(queryClient);
    await waitFor(() => expect(result.current.shown.isSuccess).toBe(true));
    respondByRoute([[/tables\/orders$/, { body: tableOf([row('a', 2)]) }]]);
    applyEvent(queryClient, recordEvent(T));
    await closeWindow();
    await waitFor(() => expect(result.current.changes.any).toBe(true));

    act(() => {
      result.current.reload();
    });
    expect(
      queryClient.getQueryData(queryKeys.recordTableLatest(C, T)),
    ).toBeUndefined();
    await waitFor(() =>
      expect(result.current.shown.data?.rows[0]?.version).toBe(2),
    );
    expect(result.current.changes.any).toBe(false);
  });

  it('says the table was deleted elsewhere when it is gone', async () => {
    respondByRoute([[/tables\/orders$/, { body: tableOf([row('a')]) }]]);
    const queryClient = newClient();
    const { result } = openTable(queryClient);
    await waitFor(() => expect(result.current.shown.isSuccess).toBe(true));

    respondByRoute([
      [/tables\/orders$/, { status: 404, body: { message: 'no such table' } }],
    ]);
    applyEvent(queryClient, recordEvent(T));
    await closeWindow();
    await waitFor(() => expect(result.current.changes.dropped).toBe(true));
    expect(result.current.changes.any).toBe(true);
  });
});

describe('useLiveRecordSearchChanges (001.05)', () => {
  beforeEach(() => {
    installFetchMock();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => vi.useRealTimers());

  const searchOf = (groups: [string, TimedRecord[]][]): RecordSearchResult => ({
    groups: groups.map(([name, rows]) => ({
      definition: definition(name),
      rows,
    })),
    truncated: false,
  });

  it('compares each shown table, and counts tables newly in the results as added', async () => {
    respondByRoute([
      [/records\/search$/, { body: searchOf([[T, [row('a'), row('b')]]]) }],
    ]);
    const queryClient = newClient();
    const { result } = render(queryClient, () => {
      const shown = useRecordSearch(C, 'Ann');
      return {
        shown,
        changes: useLiveRecordSearchChanges(C, 'Ann', shown.data),
      };
    });
    await waitFor(() => expect(result.current.shown.isSuccess).toBe(true));

    respondByRoute([
      [
        /records\/search$/,
        {
          body: searchOf([
            [T, [row('a', 2)]],
            ['stock', [row('s')]],
          ]),
        },
      ],
    ]);
    applyEvent(queryClient, recordEvent('stock'));
    await closeWindow();

    await waitFor(() => expect(result.current.changes.any).toBe(true));
    const orders = result.current.changes.byTable.get(T);
    expect([...(orders?.changed ?? [])]).toEqual(['a']);
    expect([...(orders?.deleted ?? [])]).toEqual(['b']);
    expect(result.current.changes.added).toBe(1);
  });
});
