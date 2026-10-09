import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { WireEvent } from '@tcp/shared/client';
import { describe, expect, it, vi } from 'vitest';

import { applyEvent } from './cache';

/** A minimal `state_change` audit {@link WireEvent} carrying the given payload. */
const auditEvent = (
  payload: Record<string, unknown>,
  agentId: string | null = null,
): WireEvent => ({
  type: 'audit',
  event: {
    timestamp: '2026-08-07T00:00:00.000Z',
    companyId: 'company-1',
    role: 'owner',
    agentId,
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

  /**
   * The live-agent gap 002.04 left: the company channel carries agent rows, but
   * the writers were never taught to attach a summary. Only the priming path
   * sends one, so a list that renders correctly on subscribe would then be
   * refetched wholesale on every subsequent status change.
   */
  it('keeps a patch when a fetch that started before it lands after it', async () => {
    const queryClient = newClient();
    const listKey = ['agent', 'list', { companyId: 'company-1' }];
    queryClient.setQueryData(listKey, [{ id: 'agent-1', status: 'idle' }]);

    // The first fetch read the database before the write; any later one reads
    // it after.
    let calls = 0;
    let releaseStale: () => void = () => undefined;
    const observer = new QueryObserver(queryClient, {
      queryKey: listKey,
      queryFn: () => {
        calls += 1;
        if (calls > 1)
          return Promise.resolve([{ id: 'agent-1', status: 'running' }]);
        return new Promise<unknown[]>((resolve) => {
          releaseStale = () => resolve([{ id: 'agent-1', status: 'idle' }]);
        });
      },
    });
    const unsubscribe = observer.subscribe(() => undefined);
    expect(queryClient.isFetching({ queryKey: listKey })).toBe(1);

    applyEvent(
      queryClient,
      auditEvent({ entity: 'agent', newStatus: 'running' }, 'agent-1'),
    );
    releaseStale();
    await vi.waitFor(() => {
      expect(queryClient.isFetching({ queryKey: listKey })).toBe(0);
    });
    unsubscribe();

    expect(queryClient.getQueryData(listKey)).toEqual([
      { id: 'agent-1', status: 'running' },
    ]);
  });

  describe('an agent state change with no summary', () => {
    it('patches the row it names, without invalidating', () => {
      const queryClient = newClient();
      const listKey = ['agent', 'list', { companyId: 'company-1' }];
      queryClient.setQueryData(listKey, [
        { id: 'agent-1', status: 'idle', initialPrompt: 'draft the report' },
        { id: 'agent-2', status: 'running', initialPrompt: 'review it' },
      ]);

      applyEvent(
        queryClient,
        auditEvent({ entity: 'agent', newStatus: 'running' }, 'agent-1'),
      );

      expect(queryClient.getQueryData(listKey)).toEqual([
        // `pauseReason: null` rides along on every non-paused patch (000.03),
        // so a row that later pauses for rate limiting never reads a reason
        // left over from a pause two statuses ago.
        {
          id: 'agent-1',
          status: 'running',
          initialPrompt: 'draft the report',
          pauseReason: null,
        },
        { id: 'agent-2', status: 'running', initialPrompt: 'review it' },
      ]);
      // The fields the live row could not carry survive the patch — this is a
      // merge onto the fetched row, not a replacement of it.
      expect(isInvalidated(queryClient, listKey)).toBe(false);
    });

    it('still invalidates when it names an agent no list has', () => {
      const queryClient = newClient();
      const listKey = ['agent', 'list', { companyId: 'company-1' }];
      const cached = [{ id: 'agent-1', status: 'idle' }];
      queryClient.setQueryData(listKey, cached);

      applyEvent(
        queryClient,
        auditEvent({ entity: 'agent', newStatus: 'idle' }, 'agent-new'),
      );

      // An agent started since the fetch has to arrive somehow.
      expect(queryClient.getQueryData(listKey)).toBe(cached);
      expect(isInvalidated(queryClient, listKey)).toBe(true);
    });

    it('prefers a real summary whenever one is present', () => {
      const queryClient = newClient();
      const listKey = ['agent', 'list', {}];
      queryClient.setQueryData(listKey, [{ id: 'agent-1', status: 'idle' }]);

      // `agentId` and the summary disagree. The summary is the richer, and the
      // one the writers will send once they are fixed, so it must win.
      applyEvent(
        queryClient,
        auditEvent(
          {
            entity: 'agent',
            newStatus: 'running',
            summary: { id: 'agent-1', status: 'paused', roleId: 'role-1' },
          },
          'agent-other',
        ),
      );

      expect(queryClient.getQueryData(listKey)).toEqual([
        { id: 'agent-1', status: 'paused', roleId: 'role-1' },
      ]);
    });

    it('falls back to invalidating when the row names no agent', () => {
      const queryClient = newClient();
      const listKey = ['agent', 'list', {}];
      queryClient.setQueryData(listKey, [{ id: 'agent-1', status: 'idle' }]);

      // A `null` agentId is the envelope's default, not a fabricated case —
      // there is no row to patch, so the old behaviour has to remain.
      applyEvent(
        queryClient,
        auditEvent({ entity: 'agent', newStatus: 'idle' }),
      );

      expect(isInvalidated(queryClient, listKey)).toBe(true);
    });

    it('leaves other entities on the invalidate path', () => {
      const queryClient = newClient();
      const listKey = ['task', 'list', {}];
      queryClient.setQueryData(listKey, [{ id: 'task-1', status: 'ready' }]);

      // The same shape, for a task. Only agents are missing their summary, so
      // only agents get reconstructed — anything wider would guess.
      applyEvent(
        queryClient,
        auditEvent({ entity: 'task', newStatus: 'succeeded' }, 'agent-1'),
      );

      expect(isInvalidated(queryClient, listKey)).toBe(true);
    });

    it('carries pauseReason and resumeAfter from a rate-limited pause', () => {
      const queryClient = newClient();
      const listKey = ['agent', 'list', { companyId: 'company-1' }];
      queryClient.setQueryData(listKey, [{ id: 'agent-1', status: 'running' }]);

      applyEvent(
        queryClient,
        auditEvent(
          {
            entity: 'agent',
            newStatus: 'paused',
            reason: 'rate_limited',
            rateLimit: 'rate',
            resumeAfter: '2026-08-10T09:05:00.000Z',
          },
          'agent-1',
        ),
      );

      expect(queryClient.getQueryData(listKey)).toEqual([
        {
          id: 'agent-1',
          status: 'paused',
          pauseReason: 'rate_limited',
          resumeAfter: '2026-08-10T09:05:00.000Z',
        },
      ]);
    });

    it('carries a null resumeAfter when auto-resume is off', () => {
      const queryClient = newClient();
      const listKey = ['agent', 'list', { companyId: 'company-1' }];
      queryClient.setQueryData(listKey, [{ id: 'agent-1', status: 'running' }]);

      applyEvent(
        queryClient,
        auditEvent(
          {
            entity: 'agent',
            newStatus: 'paused',
            reason: 'rate_limited',
            rateLimit: 'quota',
            resumeAfter: null,
          },
          'agent-1',
        ),
      );

      expect(queryClient.getQueryData(listKey)).toEqual([
        {
          id: 'agent-1',
          status: 'paused',
          pauseReason: 'rate_limited',
          resumeAfter: null,
        },
      ]);
    });

    it('clears pauseReason once the agent leaves paused', () => {
      const queryClient = newClient();
      const listKey = ['agent', 'list', { companyId: 'company-1' }];
      queryClient.setQueryData(listKey, [
        {
          id: 'agent-1',
          status: 'paused',
          pauseReason: 'rate_limited',
          resumeAfter: '2026-08-10T09:05:00.000Z',
        },
      ]);

      // The sweep resumed it — no `reason`/`resumeAfter` on a plain running event.
      applyEvent(
        queryClient,
        auditEvent({ entity: 'agent', newStatus: 'running' }, 'agent-1'),
      );

      expect(queryClient.getQueryData(listKey)).toEqual([
        {
          id: 'agent-1',
          status: 'running',
          pauseReason: null,
          resumeAfter: '2026-08-10T09:05:00.000Z',
        },
      ]);
    });
  });

  it('patches pausedAt and pausedBy into a cached task, and clears them', () => {
    const queryClient = newClient();
    const detailKey = ['task', 'detail', 'task-1'];
    queryClient.setQueryData(detailKey, {
      id: 'task-1',
      status: 'in-progress',
    });
    const change = (summary: Record<string, unknown>) =>
      applyEvent(
        queryClient,
        auditEvent({ entity: 'task', newStatus: 'in-progress', summary }),
      );

    change({
      id: 'task-1',
      status: 'in-progress',
      pausedAt: '2026-08-07T00:00:00.000Z',
      pausedBy: 'Ada',
    });
    expect(queryClient.getQueryData(detailKey)).toMatchObject({
      pausedAt: '2026-08-07T00:00:00.000Z',
      pausedBy: 'Ada',
    });

    change({
      id: 'task-1',
      status: 'in-progress',
      pausedAt: null,
      pausedBy: null,
    });
    expect(queryClient.getQueryData(detailKey)).toMatchObject({
      pausedAt: null,
      pausedBy: null,
    });
  });
});
