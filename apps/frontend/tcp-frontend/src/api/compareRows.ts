import type { RecordTableDefinition, TimedRecord } from './dtos';

/** How the rows on screen differ from a fresher copy read in the background. */
export interface RowChanges {
  /** Rows on screen that have since been changed elsewhere. */
  readonly changed: ReadonlySet<string>;
  /** Rows on screen that have since been deleted elsewhere. */
  readonly deleted: ReadonlySet<string>;
  /** How many rows exist now that aren't on screen. */
  readonly added: number;
}

/** No difference: what a sheet with no fresher copy shows. */
export const NO_ROW_CHANGES: RowChanges = {
  changed: new Set(),
  deleted: new Set(),
  added: 0,
};

/**
 * Compares the rows on screen with a fresher copy, by id and version (001.05).
 * Only a *higher* version counts as changed: a row edited here is patched in
 * both copies, and a copy read before that edit landed is older, not newer.
 *
 * A `truncated` copy holds only the newest rows, so a row missing from it may
 * just have been pushed out by newer ones: nothing is called deleted then.
 */
export const compareRows = (
  shown: readonly TimedRecord[],
  fresh: readonly TimedRecord[],
  truncated = false,
): RowChanges => {
  const freshById = new Map(fresh.map((row) => [row.id, row]));
  const changed = new Set<string>();
  const deleted = new Set<string>();
  for (const row of shown) {
    const now = freshById.get(row.id);
    if (now === undefined) {
      if (!truncated) deleted.add(row.id);
    } else if (now.version > row.version) changed.add(row.id);
  }
  const shownIds = new Set(shown.map((row) => row.id));
  const added = fresh.filter((row) => !shownIds.has(row.id)).length;
  return { changed, deleted, added };
};

/** JSON with object keys sorted at every level: Postgres `jsonb` keeps no key order. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );

/**
 * Whether two copies of a table have the same columns and keys (001.06).
 * Retention, name and purpose don't count: they change no cell.
 */
export const sameColumns = (
  shown: RecordTableDefinition,
  fresh: RecordTableDefinition,
): boolean =>
  canonical([shown.schema, shown.primaryKey, shown.uniqueKeys]) ===
  canonical([fresh.schema, fresh.primaryKey, fresh.uniqueKeys]);
