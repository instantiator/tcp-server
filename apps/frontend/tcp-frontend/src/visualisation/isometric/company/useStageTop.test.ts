import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STAGE_TOP_PROPERTY, useStageTop } from './useStageTop';

/** An element whose bounding rect reports `top`, changeable between measurements. */
function elementAt(top: number) {
  const element = document.createElement('section');
  let current = top;
  vi.spyOn(element, 'getBoundingClientRect').mockImplementation(
    () => ({ top: current }) as DOMRect,
  );
  return {
    element,
    moveTo: (next: number) => {
      current = next;
    },
  };
}

describe('useStageTop', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the element's page offset, scroll included", () => {
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(100);
    const { element } = elementAt(250);

    renderHook(() => {
      useStageTop({ current: element });
    });

    expect(element.style.getPropertyValue(STAGE_TOP_PROPERTY)).toBe('350px');
  });

  it('measures again when the window resizes, and stops once unmounted', () => {
    const { element, moveTo } = elementAt(200);
    const { unmount } = renderHook(() => {
      useStageTop({ current: element });
    });

    moveTo(300);
    window.dispatchEvent(new Event('resize'));
    expect(element.style.getPropertyValue(STAGE_TOP_PROPERTY)).toBe('300px');

    unmount();
    moveTo(400);
    window.dispatchEvent(new Event('resize'));
    expect(element.style.getPropertyValue(STAGE_TOP_PROPERTY)).toBe('300px');
  });

  it('does nothing without an element', () => {
    expect(() =>
      renderHook(() => {
        useStageTop({ current: null });
      }),
    ).not.toThrow();
  });
});
