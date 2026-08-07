import { QueryClient } from '@tanstack/react-query';
import type { WireEvent } from '@tcp/shared/client';
import { describe, expect, it } from 'vitest';

import { applyEvent } from './cache';

/** A minimal `state_change` audit {@link WireEvent} carrying the given payload. */
const auditEvent = (payload: Record<string, unknown>): WireEvent => ({
  type: 'audit',
  event: {
    timestamp: '2026-08-07T00:00:00.000Z',
    companyId: 'company-1',
    role: 'owner',
    agentId: null,
    assignmentId: null,
    taskId: null,
    eventType: 'state_change',
    payload,
  },
});

const streamDelta: WireEvent = {
  type: 'stream',
  agentId: 'agent-1',
  channel: 'response',
  delta: 'hello',
  timestamp: '2026-08-07T00:00:00.000Z',
};

/** A fresh cache with retries off, matching the house test style. */
const newClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

const isInvalidated = (
  queryClient: QueryClient,
  queryKey: readonly unknown[],
): boolean => queryClient.getQueryState(queryKey)?.isInvalidated ?? false;

describe('applyEvent', () => {
  it('patches a matching cached list row and a matching cached detail, with no refetch', () => {
    const queryClient = newClient();
    const listKey = ['task', 'list', {}];
    const detailKey = ['task', 'detail', 'task-1'];
    queryClient.setQueryData(listKey, [
      { id: 'task-1', status: 'pending', request: 'old' },
      { id: 'task-2', status: 'running', request: 'other' },
    ]);
    queryClient.setQueryData(detailKey, {
      id: 'task-1',
      status: 'pending',
      request: 'old',
    });

    applyEvent(
      queryClient,
      auditEvent({
        entity: 'task',
        summary: { id: 'task-1', status: 'succeeded' },
      }),
    );

    expect(queryClient.getQueryData(listKey)).toEqual([
      { id: 'task-1', status: 'succeeded', request: 'old' },
      { id: 'task-2', status: 'running', request: 'other' },
    ]);
    expect(queryClient.getQueryData(detailKey)).toEqual({
      id: 'task-1',
      status: 'succeeded',
      request: 'old',
    });
    // A row matched, so a refetch was never scheduled.
    expect(isInvalidated(queryClient, listKey)).toBe(false);
    expect(isInvalidated(queryClient, detailKey)).toBe(false);
  });

  it('invalidates its key when the entity event carries no summary', () => {
    const queryClient = newClient();
    const detailKey = ['company', 'detail', 'company-1'];
    queryClient.setQueryData(detailKey, { id: 'company-1', name: 'Acme' });

    // Real events like this exist with no summary at all — a replay marker.
    applyEvent(
      queryClient,
      auditEvent({ entity: 'company', reason: 'replay' }),
    );

    expect(isInvalidated(queryClient, detailKey)).toBe(true);
  });

  it('leaves the cache untouched for a stream delta', () => {
    const queryClient = newClient();
    const listKey = ['task', 'list', {}];
    const cached = [{ id: 'task-1', status: 'pending' }];
    queryClient.setQueryData(listKey, cached);

    applyEvent(queryClient, streamDelta);

    // Reference equality, not just equal contents: neither setQueriesData nor
    // invalidateQueries ran at all.
    expect(queryClient.getQueryData(listKey)).toBe(cached);
    expect(isInvalidated(queryClient, listKey)).toBe(false);
  });

  it('ignores an event with no entity, or an entity outside EVENT_ENTITIES', () => {
    const queryClient = newClient();
    const listKey = ['task', 'list', {}];
    const cached = [{ id: 'task-1', status: 'pending' }];
    queryClient.setQueryData(listKey, cached);

    applyEvent(queryClient, auditEvent({ text: 'a chat message' }));
    applyEvent(
      queryClient,
      auditEvent({ entity: 'not-a-real-entity', summary: { id: 'task-1' } }),
    );

    expect(queryClient.getQueryData(listKey)).toBe(cached);
    expect(isInvalidated(queryClient, listKey)).toBe(false);
  });

  it('invalidates the list key when a summary matches no cached row', () => {
    const queryClient = newClient();
    const listKey = ['task', 'list', {}];
    const cached = [{ id: 'task-1', status: 'pending' }];
    queryClient.setQueryData(listKey, cached);

    applyEvent(
      queryClient,
      auditEvent({
        entity: 'task',
        summary: { id: 'task-999', status: 'succeeded' },
      }),
    );

    // No row matched, so the array comes back unchanged (identity)...
    expect(queryClient.getQueryData(listKey)).toBe(cached);
    // ...and the list is invalidated instead, so a newly created row appears.
    // `invalidateQueries({ queryKey: ['task', 'list'] })` matches by prefix,
    // so this reaches the concrete, params-carrying key above.
    expect(isInvalidated(queryClient, listKey)).toBe(true);
  });
});
