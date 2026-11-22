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

import type { MemoryDto, MemoryList } from './dtos';
import {
  useLiveRoleMemories,
  useLiveRoleMemoryChanges,
  useReloadRoleMemories,
  useUpdateMemory,
} from './hooks';
import { RECORD_CHANGE_WINDOW_MS } from './record-changes';

vi.mock('../auth/unauthorized', () => ({ handleUnauthorized: vi.fn() }));

window.__TCP_CONFIG__ = {
  oidcIssuerUrl: 'https://idp.example.com',
  oidcClientId: 'test-web-client',
};

const ROLE = 'role-1';
const OTHER = 'role-2';
const NOW = '2026-10-15T00:00:00.000Z';

const memory = (id: string, version = 1): MemoryDto => ({
  id,
  content: `memory ${id}`,
  tags: [],
  agentId: null,
  version,
  createdAt: NOW,
  updatedAt: NOW,
});

const listOf = (memories: MemoryDto[]): MemoryList => ({
  memories,
  truncated: false,
  canWrite: true,
});

/** A `memory` signal as the company stream sends it. */
const memoryEvent = (roleId?: string): WireEvent => ({
  type: 'audit',
  event: {
    timestamp: NOW,
    companyId: 'company-1',
    role: 'agent',
    agentId: null,
    assignmentId: null,
    taskId: null,
    eventType: 'state_change',
    payload: { entity: 'memory', action: 'create', ...(roleId && { roleId }) },
  },
});

const newClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

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

/** How many times a role's memories were read. */
const reads = (roleId: string) =>
  requestedUrls().filter((url) =>
    new URL(url).pathname.endsWith(`/role/${roleId}/memory`),
  ).length;

/** An open memory list and its changes, as the panel reads them. */
const openList = (queryClient: QueryClient, roleId = ROLE) =>
  render(queryClient, () => {
    const shown = useLiveRoleMemories(roleId);
    return {
      shown,
      changes: useLiveRoleMemoryChanges(roleId, shown.data),
      update: useUpdateMemory(roleId),
      reload: useReloadRoleMemories(roleId),
    };
  });

describe('memory changes heard on the company stream (002.06)', () => {
  beforeEach(() => {
    installFetchMock();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => vi.useRealTimers());

  it('reports a memory added elsewhere once the window closes', async () => {
    respondByRoute([[/memory$/, { body: listOf([memory('a')]) }]]);
    const queryClient = newClient();
    const { result } = openList(queryClient);
    await waitFor(() => expect(result.current.shown.isSuccess).toBe(true));
    const shown = result.current.shown.data;

    respondByRoute([[/memory$/, { body: listOf([memory('b'), memory('a')]) }]]);
    applyEvent(queryClient, memoryEvent(ROLE));
    await closeWindow();

    await waitFor(() => expect(result.current.changes.added).toBe(1));
    expect(result.current.changes.any).toBe(true);
    // What is on screen is the same object: nothing replaced it.
    expect(result.current.shown.data).toBe(shown);
  });

  it('reads nothing for another role', async () => {
    respondByRoute([[/memory$/, { body: listOf([memory('a')]) }]]);
    const queryClient = newClient();
    const { result } = openList(queryClient);
    await waitFor(() => expect(result.current.shown.isSuccess).toBe(true));

    applyEvent(queryClient, memoryEvent(OTHER));
    await closeWindow();

    expect(reads(ROLE)).toBe(1);
    expect(reads(OTHER)).toBe(0);
    expect(result.current.changes.any).toBe(false);
  });

  it('re-reads every open role after a replay event, which names none', async () => {
    respondByRoute([[/memory$/, { body: listOf([memory('a')]) }]]);
    const queryClient = newClient();
    const first = openList(queryClient, ROLE);
    const second = openList(queryClient, OTHER);
    await waitFor(() =>
      expect(first.result.current.shown.isSuccess).toBe(true),
    );
    await waitFor(() =>
      expect(second.result.current.shown.isSuccess).toBe(true),
    );

    applyEvent(queryClient, memoryEvent());
    await closeWindow();

    expect(reads(ROLE)).toBe(2);
    expect(reads(OTHER)).toBe(2);
  });

  it('never reports an update made here as made elsewhere', async () => {
    respondByRoute([
      [/memory$/, { body: listOf([memory('a')]) }],
      [/memory\/a$/, { body: memory('a', 2) }],
    ]);
    const queryClient = newClient();
    const { result } = openList(queryClient);
    await waitFor(() => expect(result.current.shown.isSuccess).toBe(true));

    await act(() =>
      result.current.update.mutateAsync({ id: 'a', content: 'new' }),
    );
    // The echo of our own change: the server's list already has version 2.
    respondByRoute([[/memory$/, { body: listOf([memory('a', 2)]) }]]);
    applyEvent(queryClient, memoryEvent(ROLE));
    await closeWindow();

    await waitFor(() => expect(reads(ROLE)).toBe(2));
    expect(result.current.shown.data?.memories[0]?.version).toBe(2);
    expect(result.current.changes.any).toBe(false);
  });

  it('clears the reported change on Reload', async () => {
    respondByRoute([[/memory$/, { body: listOf([memory('a')]) }]]);
    const queryClient = newClient();
    const { result } = openList(queryClient);
    await waitFor(() => expect(result.current.shown.isSuccess).toBe(true));

    respondByRoute([[/memory$/, { body: listOf([memory('a', 2)]) }]]);
    applyEvent(queryClient, memoryEvent(ROLE));
    await closeWindow();
    await waitFor(() => expect(result.current.changes.any).toBe(true));

    act(() => {
      result.current.reload();
    });
    await waitFor(() =>
      expect(result.current.shown.data?.memories[0]?.version).toBe(2),
    );
    expect(result.current.changes.any).toBe(false);
  });
});
