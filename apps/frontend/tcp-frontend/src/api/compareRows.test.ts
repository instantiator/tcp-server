import { describe, expect, it } from 'vitest';

import { compareRows, sameColumns } from './compareRows';
import type { RecordTableDefinition, TimedRecord } from './dtos';

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

describe('sameColumns', () => {
  const orders = (extra: Partial<RecordTableDefinition> = {}) =>
    ({
      id: 'd1',
      name: 'orders',
      purpose: 'Orders',
      primaryKey: ['order_id'],
      uniqueKeys: [],
      schema: {
        properties: { order_id: { type: 'string' }, qty: { type: 'integer' } },
        required: ['order_id', 'qty'],
      },
      retention: null,
      ...extra,
    }) satisfies RecordTableDefinition;

  it('ignores key order, which jsonb does not keep', () => {
    expect(
      sameColumns(
        orders(),
        orders({
          schema: {
            required: ['order_id', 'qty'],
            properties: {
              qty: { type: 'integer' },
              order_id: { type: 'string' },
            },
          },
        }),
      ),
    ).toBe(true);
  });

  it('ignores retention and purpose, which change no cell', () => {
    expect(
      sameColumns(
        orders(),
        orders({
          purpose: 'All orders',
          retention: { days: 30, from: 'updated' },
        }),
      ),
    ).toBe(true);
  });

  it('notices an added or renamed column, and a new key', () => {
    const renamed = orders({
      schema: {
        properties: {
          order_id: { type: 'string' },
          amount: { type: 'integer' },
        },
        required: ['order_id', 'amount'],
      },
    });
    expect(sameColumns(orders(), renamed)).toBe(false);
    expect(
      sameColumns(orders(), orders({ primaryKey: ['order_id', 'qty'] })),
    ).toBe(false);
  });
});
