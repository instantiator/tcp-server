import type { Query, QueryClient } from '@tanstack/react-query';

import type { MemoryList } from './dtos';
import { fetchRoleMemories } from './endpoints';
import { ApiError } from './errors';
import { queryKeys } from './query-keys';
import { RECORD_CHANGE_WINDOW_MS } from './record-changes';

/** What a fresher copy of a role's memories holds, or `null` once the role is gone. */
export type LatestMemories = MemoryList | null;

/** The roles changed in the current window; `'all'` when unsaid. */
let pending: Set<string> | 'all' | undefined;

/** The role a memory key belongs to, read without a cast. */
const keyRoleId = (query: Query): unknown => {
  const params: unknown = query.queryKey[2];
  return typeof params === 'object' && params !== null && 'roleId' in params
    ? params.roleId
    : undefined;
};

/**
 * Notes that a role's memories changed elsewhere (002.06), from a `memory`
 * event on the company stream. Within one window, every memory list someone
 * has open for that role is read again into its `latest` key. What is on
 * screen is never replaced: the panel compares the two and says what changed,
 * and **Reload** shows it (ADR-027).
 *
 * `roleId` is absent for the re-check primed on every (re)connect, which
 * looks at every open list.
 */
export const memoryChanged = (
  queryClient: QueryClient,
  roleId: string | undefined,
): void => {
  if (pending === undefined) {
    setTimeout(() => flush(queryClient), RECORD_CHANGE_WINDOW_MS);
  }
  pending =
    roleId === undefined || pending === 'all'
      ? 'all'
      : new Set([...(pending ?? []), roleId]);
};

/** Acts on the gathered changes. */
const flush = (queryClient: QueryClient): void => {
  const roles = pending;
  pending = undefined;
  if (roles === undefined) return;

  for (const query of queryClient
    .getQueryCache()
    .findAll({ queryKey: ['memory', 'list'] })) {
    const roleId = keyRoleId(query);
    if (typeof roleId !== 'string' || query.getObserversCount() === 0) continue;
    if (roles !== 'all' && !roles.has(roleId)) continue;
    void queryClient
      .fetchQuery({
        queryKey: queryKeys.roleMemoriesLatest(roleId),
        queryFn: (): Promise<LatestMemories> =>
          fetchRoleMemories(roleId).catch((error: unknown) => {
            // The role was deleted elsewhere: the panel says so.
            if (error instanceof ApiError && error.status === 404) return null;
            throw error;
          }),
        staleTime: 0,
        retry: false,
      })
      // A failed read leaves the last copy; the next change tries again.
      .catch(() => undefined);
  }
};

/**
 * Forgets a role's fresher copy, cancelling any read in flight. Called
 * whenever what is on screen is read again, so a copy older than the screen
 * is never compared with it.
 */
export const forgetLatestMemories = (
  queryClient: QueryClient,
  roleId: string,
): void => {
  const filters = { queryKey: queryKeys.roleMemoriesLatest(roleId) };
  void queryClient.cancelQueries(filters);
  queryClient.removeQueries(filters);
};
