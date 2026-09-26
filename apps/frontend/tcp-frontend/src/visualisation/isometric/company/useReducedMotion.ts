import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/**
 * The OS-level reduced motion preference (ADR-026: honoured from the start).
 * Read once for the initial render, then kept in step with the `change`
 * event so a preference switched mid-session — without a reload — still
 * reaches the scene's `motion-preference` bus event.
 */
export const useReducedMotion = (): boolean => {
  const [reduced, setReduced] = useState(
    () => window.matchMedia(QUERY).matches,
  );

  useEffect(() => {
    const mediaQueryList = window.matchMedia(QUERY);
    const onChange = (): void => {
      setReduced(mediaQueryList.matches);
    };
    mediaQueryList.addEventListener('change', onChange);
    return () => {
      mediaQueryList.removeEventListener('change', onChange);
    };
  }, []);

  return reduced;
};
