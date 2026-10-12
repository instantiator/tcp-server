import { useCallback, useMemo, useState } from 'react';

/**
 * One change made in this session, with what undoing it needs. `row` is the
 * row's name for people (its key values); `rowId` is its record id.
 */
export type RecordChange =
  | {
      readonly kind: 'edit';
      readonly rowId: string;
      readonly row: string;
      readonly field: string;
      /** The value before the change; `undefined` when the field was empty. */
      readonly from: unknown;
    }
  | { readonly kind: 'add'; readonly rowId: string; readonly row: string }
  | {
      readonly kind: 'delete';
      readonly rowId: string;
      readonly row: string;
      readonly data: Readonly<Record<string, unknown>>;
    };

/** The session's changes, newest last, and what can be done with them. */
export interface UndoStack {
  readonly changes: readonly RecordChange[];
  readonly push: (change: RecordChange) => void;
  /** The newest change, without removing it, or `undefined`. */
  readonly last: RecordChange | undefined;
  /**
   * Drops the newest change once it has been undone. When undoing brought a
   * deleted row back under a new id, `restoredId` re-points older changes
   * at it, so they can still be undone.
   */
  readonly pop: (restoredId?: string) => void;
  readonly clear: () => void;
  /** `rowId:field` for each edited cell, and the ids of added rows: what to mark. */
  readonly editedCells: ReadonlySet<string>;
  readonly addedRows: ReadonlySet<string>;
}

/**
 * Tracks the changes a person makes to one table, so each can be undone in
 * turn. The marks on edited cells and added rows are read from the same list,
 * so undoing a change also removes its mark.
 */
export const useUndoStack = (): UndoStack => {
  const [changes, setChanges] = useState<readonly RecordChange[]>([]);

  const push = useCallback((change: RecordChange) => {
    setChanges((previous) => [...previous, change]);
  }, []);

  const pop = useCallback((restoredId?: string) => {
    setChanges((previous) => {
      const undone = previous.at(-1);
      const rest = previous.slice(0, -1);
      if (undone?.kind !== 'delete' || restoredId === undefined) return rest;
      return rest.map((change) =>
        change.rowId === undone.rowId
          ? { ...change, rowId: restoredId }
          : change,
      );
    });
  }, []);

  const clear = useCallback(() => setChanges([]), []);

  const editedCells = useMemo(
    () =>
      new Set(
        changes.flatMap((c) =>
          c.kind === 'edit' ? [`${c.rowId}:${c.field}`] : [],
        ),
      ),
    [changes],
  );
  const addedRows = useMemo(
    () => new Set(changes.flatMap((c) => (c.kind === 'add' ? [c.rowId] : []))),
    [changes],
  );

  return {
    changes,
    push,
    last: changes.at(-1),
    pop,
    clear,
    editedCells,
    addedRows,
  };
};
