import type { QueryClient } from '@tanstack/react-query';
import type { WireEvent } from '@tcp/shared/client';

import { EVENT_ENTITIES, type EventEntity } from '../api/query-keys';

/** Narrows to a plain object, so a property can be read without an `any` cast. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Narrows to the shape every event summary has: an object with a string `id`. */
const hasStringId = (
  value: unknown,
): value is { id: string } & Record<string, unknown> =>
  isRecord(value) && typeof value.id === 'string';

/** Narrows `payload.entity` to one of the keys a live event is allowed to touch. */
const isEventEntity = (value: unknown): value is EventEntity =>
  typeof value === 'string' &&
  (EVENT_ENTITIES as readonly string[]).includes(value);

/**
 * `Array.isArray` alone narrows `unknown` to `any[]`, not `unknown[]` — this
 * is the same check, typed so the map below stays free of an implicit `any`.
 */
const isUnknownArray = (value: unknown): value is unknown[] =>
  Array.isArray(value);

/**
 * Folds one {@link WireEvent} into the query cache.
 *
 * A `state_change` payload that carries a `summary` patches the matching
 * cached rows directly, so a list and a detail view both update without a
 * refetch. One with no summary — most `state_change` events, and the many
 * audit events (`llm_request`, `tool_call`, …) that carry no `entity` at all —
 * either invalidates the entity's queries or is ignored. A {@link StreamDelta}
 * never reaches any of this: it belongs to one open transcript's local state.
 */
export const applyEvent = (
  queryClient: QueryClient,
  event: WireEvent,
): void => {
  // Token deltas are high-frequency and append-only. They are handled by
  // `useEventStream`'s `onDelta` callback, never by the cache.
  if (event.type === 'stream') return;

  const { entity, summary } = event.event.payload;
  if (!isEventEntity(entity)) return;

  if (!hasStringId(summary)) {
    // Not awaited: a refetch it triggers happens in its own time, and nothing
    // here depends on it finishing.
    void queryClient.invalidateQueries({ queryKey: [entity] });
    return;
  }

  // Matches on the *cached value's* id, never the query key — so this needs
  // no knowledge of key shapes. `['enquiry','detail',slug]` is keyed by slug,
  // not id, and is patched with no special case for it.
  let matchedAnArrayRow = false;
  queryClient.setQueriesData({ queryKey: [entity] }, (old: unknown) => {
    if (isUnknownArray(old)) {
      let arrayMatched = false;
      const next = old.map((row: unknown) => {
        if (!hasStringId(row) || row.id !== summary.id) return row;
        arrayMatched = true;
        return { ...row, ...summary };
      });
      // Returning the array unchanged when nothing matched keeps identity, so
      // a list with no row for this entity does not re-render for nothing.
      if (!arrayMatched) return old;
      matchedAnArrayRow = true;
      return next;
    }

    if (hasStringId(old) && old.id === summary.id)
      return { ...old, ...summary };
    return old;
  });

  // No cached list held a row for this id, so the entity is new to every list
  // that's cached — without this, a newly created row never appears in one.
  // Nothing cached at all is a harmless no-op through the same call.
  if (!matchedAnArrayRow) {
    void queryClient.invalidateQueries({ queryKey: [entity, 'list'] });
  }
};
