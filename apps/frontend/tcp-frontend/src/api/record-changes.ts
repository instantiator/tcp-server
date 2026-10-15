import type { Query, QueryClient } from '@tanstack/react-query';

import type { RecordTableRows } from './dtos';
import { fetchRecordSearch, fetchRecordTable } from './endpoints';
import { ApiError } from './errors';
import { queryKeys } from './query-keys';

/**
 * How long record changes are gathered before anything is fetched.
 *
 * ponytail: a fixed 1s window per company. An agent writing rows one by one
 * costs one table read per open sheet per second; if that shows up as slow on
 * big tables, a per-row signal would let the sheet skip the read.
 */
export const RECORD_CHANGE_WINDOW_MS = 1000;

/** What a fresher copy of a table holds: its rows, or `null` once it is deleted. */
export type LatestRecordTable = RecordTableRows | null;

/** The tables changed in the current window, per company; `'all'` when unsaid. */
const pending = new Map<string, Set<string> | 'all'>();

/** The `{ companyId, … }` part of a record key, read without a cast. */
export const keyParams = (
  query: Query,
): { companyId?: unknown; table?: unknown; q?: unknown } => {
  const params: unknown = query.queryKey[2];
  return typeof params === 'object' && params !== null ? params : {};
};

/** Is anything on screen reading this query? */
const isShown = (query: Query): boolean => query.getObserversCount() > 0;

/**
 * Notes that a record table changed elsewhere (001.05), from a `record` event
 * on the company stream. Within one window, for that company:
 *
 * - the table summaries (and the do-not-store list) refetch, so the tray and
 *   the Tables tab stay current — they are ordered by name, so nothing moves;
 * - every open table and search the change could touch is read again into its
 *   `latest` key. What is on screen is never replaced: the sheet compares the
 *   two and says what changed, and **Reload** shows it (ADR-027).
 *
 * `table` is absent for a do-not-store change and for the re-check primed on
 * every (re)connect, which looks at everything open.
 */
export const recordChanged = (
  queryClient: QueryClient,
  companyId: string,
  table: string | undefined,
): void => {
  const current = pending.get(companyId);
  if (current === undefined) {
    setTimeout(() => flush(queryClient, companyId), RECORD_CHANGE_WINDOW_MS);
  }
  if (table === undefined || current === 'all') {
    pending.set(companyId, 'all');
  } else {
    pending.set(companyId, new Set([...(current ?? []), table]));
  }
};

/** Acts on one company's gathered changes. */
const flush = (queryClient: QueryClient, companyId: string): void => {
  const tables = pending.get(companyId);
  pending.delete(companyId);
  if (tables === undefined) return;
  const touches = (table: string) => tables === 'all' || tables.has(table);

  void queryClient.invalidateQueries({
    queryKey: ['record', 'list'],
    predicate: (query) => keyParams(query).companyId === companyId,
  });

  const cache = queryClient.getQueryCache();
  for (const query of cache.findAll({ queryKey: ['record', 'detail'] })) {
    const { companyId: id, table } = keyParams(query);
    if (id !== companyId || typeof table !== 'string' || table === '') continue;
    if (!isShown(query) || !touches(table)) continue;
    void queryClient
      .fetchQuery({
        queryKey: queryKeys.recordTableLatest(companyId, table),
        queryFn: (): Promise<LatestRecordTable> =>
          fetchRecordTable(companyId, table).catch((error: unknown) => {
            // Deleted elsewhere: the sheet says so and stops edits.
            if (error instanceof ApiError && error.status === 404) return null;
            throw error;
          }),
        staleTime: 0,
        retry: false,
      })
      // A failed read leaves the last copy; the next change tries again.
      .catch(() => undefined);
  }

  for (const query of cache.findAll({ queryKey: ['record', 'search'] })) {
    const { companyId: id, q } = keyParams(query);
    if (id !== companyId || typeof q !== 'string' || !isShown(query)) continue;
    // A change can bring a table into a search's results, so every open
    // search is read again, whatever tables it showed.
    void queryClient
      .fetchQuery({
        queryKey: queryKeys.recordSearchLatest(companyId, q),
        queryFn: () => fetchRecordSearch(companyId, q),
        staleTime: 0,
        retry: false,
      })
      .catch(() => undefined);
  }
};

/** Which of a company's fresher copies to forget: its table, or its search. */
export type LatestRecordFilter = (params: {
  readonly table?: unknown;
  readonly q?: unknown;
}) => boolean;

/** Every fresher search copy: what is forgotten when a search is read again. */
export const latestSearches: LatestRecordFilter = ({ q }) =>
  typeof q === 'string';

/**
 * Forgets a company's fresher copies, cancelling any read in flight. Called
 * whenever what is on screen is read again, so a copy older than the screen
 * is never compared with it. `which` narrows it; all of them by default.
 */
export const forgetLatestRecords = (
  queryClient: QueryClient,
  companyId: string,
  which: LatestRecordFilter = () => true,
): void => {
  const filters = {
    queryKey: ['record', 'latest'],
    predicate: (query: Query) => {
      const params = keyParams(query);
      return params.companyId === companyId && which(params);
    },
  };
  void queryClient.cancelQueries(filters);
  queryClient.removeQueries(filters);
};
