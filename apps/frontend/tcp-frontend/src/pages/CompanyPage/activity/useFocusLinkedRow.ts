import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';

/**
 * Brings the row a deep link names into view and focuses it (`?<param>=<id>`).
 *
 * Returns the id the URL names and a ref for the caller to put on that row.
 * Keyed on the id and on whether the list holds it, never on a "have I run?"
 * boolean, so `StrictMode`'s double effect is harmless and a changed param
 * runs again. An id the list does not hold (dismissed, answered) does nothing.
 * A hash change moves no focus (ADR-027), so this is what makes a toast's link
 * land somewhere.
 */
export const useFocusLinkedRow = (
  param: string,
  rowIds: readonly string[] | undefined,
) => {
  const [params] = useSearchParams();
  const linkedId = params.get(param);
  const present = linkedId !== null && (rowIds?.includes(linkedId) ?? false);
  const rowRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (!present) return;
    rowRef.current?.scrollIntoView({ block: 'nearest' });
    rowRef.current?.focus();
  }, [linkedId, present]);

  return { linkedId, rowRef };
};
