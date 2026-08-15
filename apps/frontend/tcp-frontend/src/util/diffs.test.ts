import { describe, expect, it } from 'vitest';

import { diffList, diffObject } from './diffs';

interface Item {
  readonly id: string;
  readonly name: string;
  readonly count?: number;
}

describe('diffObject', () => {
  it('is null when nothing changed', () => {
    const prev: Item = { id: '1', name: 'a', count: 1 };
    const next: Item = { id: '1', name: 'a', count: 1 };

    expect(diffObject(prev, next)).toBeNull();
  });

  it('is null for the same object reference', () => {
    const item: Item = { id: '1', name: 'a' };

    expect(diffObject(item, item)).toBeNull();
  });

  it('carries only the fields that changed, plus id', () => {
    const prev: Item = { id: '1', name: 'a', count: 1 };
    const next: Item = { id: '1', name: 'b', count: 1 };

    expect(diffObject(prev, next)).toEqual({ id: '1', name: 'b' });
  });

  it('carries every field that changed when more than one did', () => {
    const prev: Item = { id: '1', name: 'a', count: 1 };
    const next: Item = { id: '1', name: 'b', count: 2 };

    expect(diffObject(prev, next)).toEqual({ id: '1', name: 'b', count: 2 });
  });

  it('always carries id, even though id itself never changes between the same record', () => {
    const prev: Item = { id: '1', name: 'a' };
    const next: Item = { id: '1', name: 'z' };

    expect(diffObject(prev, next)).toHaveProperty('id', '1');
  });

  it('treats a field appearing for the first time as a change', () => {
    const prev: Item = { id: '1', name: 'a' };
    const next: Item = { id: '1', name: 'a', count: 5 };

    expect(diffObject(prev, next)).toEqual({ id: '1', count: 5 });
  });

  it('cannot see a field that disappeared, since it only walks next’s own keys', () => {
    const prev: Item = { id: '1', name: 'a', count: 5 };
    const next: Item = { id: '1', name: 'a' };

    expect(diffObject(prev, next)).toBeNull();
  });

  it('does detect a field explicitly set to undefined, unlike an omitted one', () => {
    const prev: Item = { id: '1', name: 'a', count: 5 };
    const next: Item = { id: '1', name: 'a', count: undefined };

    expect(diffObject(prev, next)).toEqual({ id: '1', count: undefined });
  });

  it('uses Object.is, so NaN compares equal to itself', () => {
    const prev = { id: '1', count: Number.NaN };
    const next = { id: '1', count: Number.NaN };

    expect(diffObject(prev, next)).toBeNull();
  });

  it('uses Object.is, so +0 and -0 are treated as different', () => {
    const prev = { id: '1', count: 0 };
    const next = { id: '1', count: -0 };

    expect(diffObject(prev, next)).toEqual({ id: '1', count: -0 });
  });

  it('compares arrays and objects by reference, not by content', () => {
    // A fresh fetch always hands back new array/object instances even when
    // nothing in them changed — diffObject has no way to know that without a
    // deep compare, and reports a change. Callers with array-valued fields
    // (e.g. RoleDTO's knowledgeDomains) need to account for this themselves.
    const prev = { id: '1', tags: ['a', 'b'] };
    const next = { id: '1', tags: ['a', 'b'] };

    expect(diffObject(prev, next)).toEqual({ id: '1', tags: ['a', 'b'] });
  });

  it('leaves the same array reference undetected as a change', () => {
    const tags = ['a', 'b'];
    const prev = { id: '1', tags };
    const next = { id: '1', tags };

    expect(diffObject(prev, next)).toBeNull();
  });
});

describe('diffList', () => {
  const a: Item = { id: 'a', name: 'Alpha' };
  const b: Item = { id: 'b', name: 'Beta' };
  const c: Item = { id: 'c', name: 'Gamma' };

  it('reports every item as created against an empty previous list', () => {
    const diff = diffList<Item>([], [a, b]);

    expect(diff.created).toEqual([a, b]);
    expect(diff.removed).toEqual([]);
    expect(diff.updated).toEqual([]);
    expect(diff.any).toBe(true);
  });

  it('reports every item as removed against an empty next list', () => {
    const diff = diffList<Item>([a, b], []);

    expect(diff.created).toEqual([]);
    expect(diff.removed).toEqual([a, b]);
    expect(diff.updated).toEqual([]);
    expect(diff.any).toBe(true);
  });

  it('reports nothing when the same items are unchanged', () => {
    const diff = diffList<Item>([a, b], [a, b]);

    expect(diff.created).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.updated).toEqual([]);
    expect(diff.any).toBe(false);
  });

  it('reports a patch for an item that changed', () => {
    const changedB: Item = { id: 'b', name: 'Beta II' };
    const diff = diffList<Item>([a, b], [a, changedB]);

    expect(diff.created).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.updated).toEqual([{ id: 'b', name: 'Beta II' }]);
    expect(diff.any).toBe(true);
  });

  it('reports created, removed and updated together in one pass', () => {
    const changedA: Item = { id: 'a', name: 'Alpha II' };
    const diff = diffList<Item>([a, b], [changedA, c]);

    expect(diff.created).toEqual([c]);
    expect(diff.removed).toEqual([b]);
    expect(diff.updated).toEqual([{ id: 'a', name: 'Alpha II' }]);
    expect(diff.any).toBe(true);
  });

  it('treats the lists as unordered', () => {
    const diff = diffList<Item>([a, b, c], [c, a, b]);

    expect(diff.created).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.updated).toEqual([]);
    expect(diff.any).toBe(false);
  });

  it('is a no-op between two empty lists', () => {
    const diff = diffList<Item>([], []);

    expect(diff).toEqual({
      created: [],
      removed: [],
      updated: [],
      any: false,
    });
  });
});
