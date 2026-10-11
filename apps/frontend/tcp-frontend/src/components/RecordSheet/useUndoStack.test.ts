import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useUndoStack } from './useUndoStack';

describe('useUndoStack', () => {
  it('marks edited cells and added rows, and drops a mark when its change is undone', () => {
    const { result } = renderHook(() => useUndoStack());
    act(() => {
      result.current.push({ kind: 'add', rowId: 'r2', row: 'B' });
      result.current.push({
        kind: 'edit',
        rowId: 'r1',
        row: 'A',
        field: 'qty',
        from: 1,
      });
    });
    expect(result.current.editedCells).toEqual(new Set(['r1:qty']));
    expect(result.current.addedRows).toEqual(new Set(['r2']));
    act(() => result.current.pop());
    expect(result.current.editedCells.size).toBe(0);
    expect(result.current.last).toMatchObject({ kind: 'add' });
  });

  it('points older changes at a deleted row once undoing brings it back', () => {
    const { result } = renderHook(() => useUndoStack());
    act(() => {
      result.current.push({
        kind: 'edit',
        rowId: 'r1',
        row: 'A',
        field: 'qty',
        from: 1,
      });
      result.current.push({
        kind: 'delete',
        rowId: 'r1',
        row: 'A',
        data: { qty: 2 },
      });
    });
    act(() => result.current.pop('r9'));
    expect(result.current.last).toMatchObject({ kind: 'edit', rowId: 'r9' });
  });
});
