import { act, renderHook } from '@testing-library/react';
import type { RefObject } from 'react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { useFullscreen } from './useFullscreen';

/**
 * jsdom implements none of the Fullscreen API, so every piece this hook reads
 * or calls has to be stood up by hand: `Element.prototype.requestFullscreen`
 * and `document.exitFullscreen` don't exist at runtime despite being in the
 * DOM lib types, and `document.fullscreenElement` is a plain, writable
 * property here rather than the read-only accessor a real browser exposes.
 */
const setFullscreenElement = (element: Element | null): void => {
  Object.defineProperty(document, 'fullscreenElement', {
    value: element,
    configurable: true,
    writable: true,
  });
};

describe('useFullscreen', () => {
  let element: HTMLElement;
  let ref: RefObject<HTMLElement | null>;
  let requestFullscreen: Mock<() => Promise<void>>;
  let exitFullscreen: Mock<() => Promise<void>>;

  beforeEach(() => {
    element = document.createElement('div');
    ref = { current: element };
    requestFullscreen = vi.fn<() => Promise<void>>(() => Promise.resolve());
    exitFullscreen = vi.fn<() => Promise<void>>(() => Promise.resolve());
    Element.prototype.requestFullscreen = requestFullscreen;
    document.exitFullscreen = exitFullscreen;
    setFullscreenElement(null);
  });

  afterEach(() => {
    Reflect.deleteProperty(Element.prototype, 'requestFullscreen');
    Reflect.deleteProperty(document, 'exitFullscreen');
    setFullscreenElement(null);
  });

  it('starts false when nothing is fullscreen', () => {
    const { result } = renderHook(() => useFullscreen(ref));

    expect(result.current.isFullscreen).toBe(false);
  });

  it('requests fullscreen on the ref element when toggled while not fullscreen', () => {
    const { result } = renderHook(() => useFullscreen(ref));

    act(() => {
      result.current.toggle();
    });

    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    expect(exitFullscreen).not.toHaveBeenCalled();
  });

  it('turns true once the document reports this element as fullscreen', () => {
    const { result } = renderHook(() => useFullscreen(ref));

    act(() => {
      setFullscreenElement(element);
      document.dispatchEvent(new Event('fullscreenchange'));
    });

    expect(result.current.isFullscreen).toBe(true);
  });

  it('exits fullscreen when toggled while fullscreen', () => {
    const { result } = renderHook(() => useFullscreen(ref));

    act(() => {
      setFullscreenElement(element);
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    act(() => {
      result.current.toggle();
    });

    expect(exitFullscreen).toHaveBeenCalledTimes(1);
    expect(requestFullscreen).not.toHaveBeenCalled();
  });

  it('turns false again once the document reports fullscreen has ended', () => {
    const { result } = renderHook(() => useFullscreen(ref));

    act(() => {
      setFullscreenElement(element);
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    act(() => {
      setFullscreenElement(null);
      document.dispatchEvent(new Event('fullscreenchange'));
    });

    expect(result.current.isFullscreen).toBe(false);
  });

  it('does not react to fullscreen changes once unmounted', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');

    const { unmount } = renderHook(() => useFullscreen(ref));
    const registered = addSpy.mock.calls.find(
      ([name]) => name === 'fullscreenchange',
    );
    expect(registered).toBeDefined();

    unmount();

    expect(removeSpy).toHaveBeenCalledWith('fullscreenchange', registered?.[1]);
  });
});
