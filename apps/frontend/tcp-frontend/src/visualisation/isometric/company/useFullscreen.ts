import { useCallback, useEffect, useState, type RefObject } from 'react';

export interface UseFullscreenResult {
  readonly isFullscreen: boolean;
  readonly toggle: () => void;
}

/**
 * Tracks whether `ref`'s element is the page's fullscreen element, and offers
 * a `toggle` that requests or exits it.
 *
 * Reads `document.fullscreenElement` directly rather than keeping its own
 * flag, because fullscreen can end for reasons this hook never asked for —
 * the user pressing Escape, or the browser's own chrome — and
 * `fullscreenchange` is the only way to learn that happened.
 */
export const useFullscreen = (
  ref: RefObject<HTMLElement | null>,
): UseFullscreenResult => {
  // Starts false: on the first render the ref is still empty, and "nothing is
  // fullscreen" would otherwise equal "our empty ref" and read as true.
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onChange = (): void => {
      setIsFullscreen(isShownFullscreen(ref.current));
    };
    onChange();
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
    };
  }, [ref]);

  const toggle = useCallback(() => {
    if (isShownFullscreen(ref.current)) {
      // ponytail: a refused exit just leaves the view fullscreen. There is
      // nothing more useful to do with the rejection than swallow it.
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    // ponytail: a refused request (no user gesture, or the browser declines)
    // just leaves the view as it was — nothing the user did wrong to fix.
    void ref.current?.requestFullscreen().catch(() => undefined);
  }, [ref]);

  return { isFullscreen, toggle };
};

/** True only when `element` exists and is the page's fullscreen element. */
const isShownFullscreen = (element: HTMLElement | null): boolean =>
  element !== null && document.fullscreenElement === element;
