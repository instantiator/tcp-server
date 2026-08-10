import { createContext, use, type ReactNode } from 'react';

/** One minimised dialog, as the dock knows it. */
export interface DockEntry {
  /** Stable across minimise and restore, so the same dialog never docks twice. */
  readonly id: string;
  /**
   * What the dock button says.
   *
   * A `ReactNode` rather than a string, so a parked dialog can keep showing
   * live state — the chat dialog's label names its agent's status, and reads it
   * from the query cache as it changes. A plain string would mean the parker
   * re-registering the entry on every update just to change its wording.
   *
   * It must still render to text and nothing else: the button's content is its
   * accessible name.
   */
  readonly label: ReactNode;
  /** Re-opens the dialog. The caller kept its state; this puts it back on screen. */
  readonly restore: () => void;
}

/** The minimised dialogs, plus the ways to change the set. */
export interface DockContextValue {
  readonly entries: readonly DockEntry[];
  /** Parks a dialog in the dock. Re-minimising the same `id` replaces its entry. */
  readonly minimise: (entry: DockEntry) => void;
  /** Removes an entry and re-opens its dialog. */
  readonly restore: (id: string) => void;
  /**
   * Removes an entry **without** re-opening it. Unknown ids are ignored.
   *
   * One dialog can hold several dock entries — the chat dialog parks each of
   * its conversations separately, so each gets its own button and its own
   * status. Restoring any one of them brings the whole dialog back, and the
   * rest of its entries then have to go without firing their own `restore`.
   */
  readonly remove: (id: string) => void;
  /**
   * Moves focus to an entry's button.
   *
   * Minimising unmounts a dialog, and focus has to land somewhere deliberate
   * rather than on the page body (ADR-027). The dock button that replaced the
   * dialog is that place.
   */
  readonly focusEntry: (id: string) => void;
}

/**
 * Held here rather than in `DockProvider.tsx` so that file exports nothing but
 * its component — `react-refresh/only-export-components` is an error, and a
 * mixed module breaks fast refresh during development.
 */
export const DockContext = createContext<DockContextValue | null>(null);

/** Reads the dock. Throws outside a `DockProvider`. */
export const useDock = (): DockContextValue => {
  const value = use(DockContext);
  if (value === null) {
    throw new Error('useDock must be used within a DockProvider');
  }
  return value;
};
