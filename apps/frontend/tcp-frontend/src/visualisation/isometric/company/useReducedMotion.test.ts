import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReducedMotion } from './useReducedMotion';

/**
 * jsdom's own `matchMedia` (stubbed globally in `test-setup.ts`) always
 * reports "no preference" and never fires `change`. This stands up a fake
 * that starts however the test wants and can be flipped by hand, the way a
 * real `MediaQueryList` would when the OS setting changes mid-session.
 *
 * Implements the full interface — not just the two members the hook reads —
 * so the fake can stand in for `window.matchMedia`'s return type with no cast.
 */
class FakeMediaQueryList implements MediaQueryList {
  matches: boolean;
  readonly media = '(prefers-reduced-motion: reduce)';
  onchange: ((this: MediaQueryList, ev: MediaQueryListEvent) => void) | null =
    null;
  // `MediaQueryList`'s own type of a listener is an `Event`-taking function;
  // the hook's own callback ignores its argument, which is a plain, no-cast
  // narrowing of the `EventListenerOrEventListenerObject` union below.
  private readonly listeners = new Set<EventListener>();

  constructor(matches: boolean) {
    this.matches = matches;
  }

  addEventListener(
    _type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    if (typeof listener === 'function') {
      this.listeners.add(listener);
    }
  }

  removeEventListener(
    _type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    if (typeof listener === 'function') {
      this.listeners.delete(listener);
    }
  }

  addListener(): void {
    // Deprecated pre-`EventTarget` API. The hook never calls it.
  }

  removeListener(): void {
    // Deprecated pre-`EventTarget` API. The hook never calls it.
  }

  dispatchEvent(): boolean {
    return false;
  }

  /** Flips `matches` and fires every registered listener, as a real change would. */
  flip(matches: boolean): void {
    this.matches = matches;
    const event = new Event('change');
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

describe('useReducedMotion', () => {
  let originalMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  const stubMatchMedia = (initialMatches: boolean): FakeMediaQueryList => {
    const mediaQueryList = new FakeMediaQueryList(initialMatches);
    window.matchMedia = vi.fn((): MediaQueryList => mediaQueryList);
    return mediaQueryList;
  };

  it('starts false when the OS has no preference', () => {
    stubMatchMedia(false);

    const { result } = renderHook(() => useReducedMotion());

    expect(result.current).toBe(false);
  });

  it('starts true when the OS already prefers reduced motion', () => {
    stubMatchMedia(true);

    const { result } = renderHook(() => useReducedMotion());

    expect(result.current).toBe(true);
  });

  it('follows a change fired after mount', () => {
    const list = stubMatchMedia(false);
    const { result } = renderHook(() => useReducedMotion());

    act(() => {
      list.flip(true);
    });

    expect(result.current).toBe(true);
  });

  it('stops listening once unmounted', () => {
    const list = stubMatchMedia(false);
    const { unmount } = renderHook(() => useReducedMotion());

    expect(list.listenerCount).toBe(1);

    unmount();

    expect(list.listenerCount).toBe(0);
  });
});
