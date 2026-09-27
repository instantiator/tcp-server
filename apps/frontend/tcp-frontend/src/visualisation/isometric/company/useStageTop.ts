import { useLayoutEffect, type RefObject } from 'react';

/** The custom property the stage's height is worked out from. */
export const STAGE_TOP_PROPERTY = '--tcp-visualisation-top';

/**
 * Writes the element's distance from the top of the *page* (not the
 * viewport, so scrolling doesn't move it) onto the element as
 * {@link STAGE_TOP_PROPERTY}. CSS then sizes the stage to whatever the
 * viewport has left below that point, with a fixed height as the floor.
 *
 * Re-measured when the window resizes, and when the page's own size changes
 * — a banner appearing, or the toolbar wrapping, moves the stage down.
 */
export function useStageTop(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) {
      return undefined;
    }

    const measure = (): void => {
      const top = element.getBoundingClientRect().top + window.scrollY;
      element.style.setProperty(STAGE_TOP_PROPERTY, `${top}px`);
    };
    measure();

    window.addEventListener('resize', measure);
    // jsdom has no ResizeObserver; the resize listener still covers a browser without one.
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(measure);
    observer?.observe(document.body);

    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [ref]);
}
