import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useActivityStamps } from './useActivityStamps';

const UPDATED = '2026-08-10T09:00:00.000Z';
const LATER = Date.parse('2026-08-10T12:00:00.000Z');

describe('useActivityStamps', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts from an agent's updatedAt, and from the fallback when unseen", () => {
    const { result } = renderHook(() =>
      useActivityStamps([{ id: 'a', status: 'idle', updatedAt: UPDATED }]),
    );
    expect(result.current('a', undefined)).toBe(Date.parse(UPDATED));
    expect(result.current('b', UPDATED)).toBe(Date.parse(UPDATED));
    expect(result.current('c', undefined)).toBe(0);
  });

  it('re-stamps on a status change, and only then', () => {
    vi.useFakeTimers();
    vi.setSystemTime(LATER);
    const { result, rerender } = renderHook(
      ({ status }) =>
        useActivityStamps([{ id: 'a', status, updatedAt: UPDATED }]),
      { initialProps: { status: 'idle' } },
    );

    // Same status again (a streamed delta re-renders without changing it).
    rerender({ status: 'idle' });
    expect(result.current('a', undefined)).toBe(Date.parse(UPDATED));

    rerender({ status: 'running' });
    expect(result.current('a', undefined)).toBe(LATER);
  });
});
