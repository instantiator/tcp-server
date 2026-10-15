import { describe, expect, it } from 'vitest';

import { compareRows } from './compareRows';
import type { TimedRecord } from './dtos';

const row = (id: string, version = 1): TimedRecord => ({
  id,
  version,
  data: {},
  createdAt: '2026-10-15T00:00:00.000Z',
  updatedAt: '2026-10-15T00:00:00.000Z',
});

describe('compareRows', () => {
  it('finds nothing when both copies hold the same versions', () => {
    const changes = compareRows([row('a'), row('b')], [row('b'), row('a')]);
    expect(changes).toEqual({
      changed: new Set(),
      deleted: new Set(),
      added: 0,
    });
  });

  it('calls a row changed only when the fresh copy has a higher version', () => {
    // 'b' is newer on screen: edited here after the copy was read.
    const changes = compareRows(
      [row('a', 1), row('b', 3)],
      [row('a', 2), row('b', 2)],
    );
    expect([...changes.changed]).toEqual(['a']);
  });

  it('calls a row missing from the fresh copy deleted', () => {
    const changes = compareRows([row('a'), row('b')], [row('a')]);
    expect([...changes.deleted]).toEqual(['b']);
  });

  it('counts rows only in the fresh copy as added', () => {
    const changes = compareRows([row('a')], [row('c'), row('a'), row('d')]);
    expect(changes.added).toBe(2);
  });

  it('calls nothing deleted when the fresh copy is truncated', () => {
    // The missing row may just have been pushed out by newer ones.
    const changes = compareRows(
      [row('a'), row('b')],
      [row('c'), row('a')],
      true,
    );
    expect(changes.deleted.size).toBe(0);
    expect(changes.added).toBe(1);
  });

  it('finds nothing in two empty copies', () => {
    expect(compareRows([], [])).toEqual({
      changed: new Set(),
      deleted: new Set(),
      added: 0,
    });
  });
});
