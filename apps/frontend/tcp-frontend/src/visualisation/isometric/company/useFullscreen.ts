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
  const [isFullscreen, setIsFullscreen] = useState(
    () => document.fullscreenElement === ref.current,
  );

  useEffect(() => {
    const onChange = (): void => {
      setIsFullscreen(document.fullscreenElement === ref.current);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
    };
  }, [ref]);

  const toggle = useCallback(() => {
    if (document.fullscreenElement === ref.current) {
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
