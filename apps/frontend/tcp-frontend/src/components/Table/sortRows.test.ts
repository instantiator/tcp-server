import { describe, expect, it } from 'vitest';
import { sortRows } from './sortRows';

const rows = [
  { name: 'role 10' },
  { name: 'Bravo' },
  { name: 'role 9' },
  { name: 'alpha' },
];
const byName = (row: { name: string }) => row.name;

describe('sortRows', () => {
  it('sorts ascending, ignoring case and reading numbers as numbers', () => {
    expect(
      sortRows(rows, { column: 'name', direction: 'ascending' }, byName).map(
        byName,
      ),
    ).toEqual(['alpha', 'Bravo', 'role 9', 'role 10']);
  });

  it('sorts descending', () => {
    expect(
      sortRows(rows, { column: 'name', direction: 'descending' }, byName).map(
        byName,
      ),
    ).toEqual(['role 10', 'role 9', 'Bravo', 'alpha']);
  });

  it('leaves the rows it was given alone', () => {
    const before = rows.map(byName);
    sortRows(rows, { column: 'name', direction: 'descending' }, byName);
    expect(rows.map(byName)).toEqual(before);
  });
});
