import type { SortDescriptor } from 'react-aria-components';

/**
 * Sorts a table's rows by the column its header asked for, client-side.
 * `value` reads the text a column sorts on. Comparison ignores case and
 * reads digits as numbers, so "role 10" follows "role 9". Returns a new
 * array; `rows` is left alone.
 */
export const sortRows = <T>(
  rows: readonly T[],
  { column, direction }: SortDescriptor,
  value: (row: T, column: string) => string,
): T[] => {
  const sign = direction === 'descending' ? -1 : 1;
  return [...rows].sort(
    (a, b) =>
      sign *
      value(a, String(column)).localeCompare(
        value(b, String(column)),
        undefined,
        {
          sensitivity: 'base',
          numeric: true,
        },
      ),
  );
};
