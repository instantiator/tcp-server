import type { QueryClient } from '@tanstack/react-query';
import type { AuditWireEvent, WireEvent } from '@tcp/shared/client';

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
 * Reconstructs the summary a live `agent` row should have carried and doesn't.
 *
 * 002.04 widened the company channel's routing predicate to five entities, but
 * it did not change the eight or so places that write an agent `state_change` —
 * several of them in tcp-agent, across a process boundary. So a **primed** agent
 * row carries an `AgentChangeSummary` and a **live** one carries nothing, and
 * the two disagree about the same entity on the same stream.
 *
 * The live row does still carry the only two fields a list needs: `agentId` on
 * the envelope, and `newStatus` in the payload. Without this, agent status —
 * the highest-frequency event on the company stream — is the one change that
 * refetches an entire list instead of patching the row it names.
 *
 * A `rate_limited` pause (000.03) carries its reason and its next-try time the
 * same summary-less way, as `reason` and `resumeAfter` on the payload — picked
 * up here too, so `agentStatusLabel` has what it needs without a refetch. A
 * row that leaves `paused` clears `pauseReason`: the field otherwise goes
 * stale and a resumed (or re-paused for an unrelated reason) agent keeps
 * reading "Rate limited" from its last pause.
 *
 * Returns `undefined` for every other entity, which falls through to the
 * invalidate path unchanged. It becomes dead code the day those writers start
 * sending a summary, and nothing here will notice: the real summary is
 * preferred whenever one is present.
 */
const synthesiseAgentPatch = (
  event: AuditWireEvent,
):
  | {
      id: string;
      status: string;
      pauseReason?: string | null;
      resumeAfter?: string | null;
    }
  | undefined => {
  const { entity, newStatus, reason, resumeAfter } = event.payload;
  if (entity !== 'agent') return undefined;
  if (typeof event.agentId !== 'string' || typeof newStatus !== 'string')
    return undefined;

  if (newStatus !== 'paused') {
    return { id: event.agentId, status: newStatus, pauseReason: null };
  }
  return {
    id: event.agentId,
    status: newStatus,
    ...(typeof reason === 'string' ? { pauseReason: reason } : {}),
    ...(typeof resumeAfter === 'string' || resumeAfter === null
      ? { resumeAfter }
      : {}),
  };
};

/**
 * Folds one {@link WireEvent} into the query cache.
 *
 * A `state_change` payload that carries a `summary` patches the matching
 * cached rows directly, so a list and a detail view both update without a
 * refetch. So does an agent row with no summary, via
 * {@link synthesiseAgentPatch}. Anything else with no usable patch — the many
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

  const patch = hasStringId(summary)
    ? summary
    : synthesiseAgentPatch(event.event);

  if (patch === undefined) {
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
        if (!hasStringId(row) || row.id !== patch.id) return row;
        arrayMatched = true;
        return { ...row, ...patch };
      });
      // Returning the array unchanged when nothing matched keeps identity, so
      // a list with no row for this entity does not re-render for nothing.
      if (!arrayMatched) return old;
      matchedAnArrayRow = true;
      return next;
    }

    if (hasStringId(old) && old.id === patch.id) return { ...old, ...patch };
    return old;
  });

  // A fetch already in flight read the database before this write, so its
  // response would land on top of the patch and undo it. Invalidating cancels
  // that fetch and refetches after the write (002.02).
  if (queryClient.isFetching({ queryKey: [entity] }) > 0) {
    void queryClient.invalidateQueries({ queryKey: [entity] });
    return;
  }

  // No cached list held a row for this id, so the entity is new to every list
  // that's cached — without this, a newly created row never appears in one.
  // Nothing cached at all is a harmless no-op through the same call.
  if (!matchedAnArrayRow) {
    void queryClient.invalidateQueries({ queryKey: [entity, 'list'] });
  }
};
