import { createContext, use } from 'react';

/** One minimised dialog, as the dock knows it. */
export interface DockEntry {
  /** Stable across minimise and restore, so the same dialog never docks twice. */
  readonly id: string;
  /** What the dock button says. Already resolved through `t`. */
  readonly label: string;
  /** Re-opens the dialog. The caller kept its state; this puts it back on screen. */
  readonly restore: () => void;
}

/** The minimised dialogs, plus the two ways to change the set. */
export interface DockContextValue {
  readonly entries: readonly DockEntry[];
  /** Parks a dialog in the dock. Re-minimising the same `id` replaces its entry. */
  readonly minimise: (entry: DockEntry) => void;
  /** Removes an entry and re-opens its dialog. */
  readonly restore: (id: string) => void;
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
