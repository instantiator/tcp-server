import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** How far from the bottom still counts as "at the latest entry". */
const AT_BOTTOM_PX = 24;

export interface Follow {
  readonly following: boolean;
  /** Turning it on jumps to the latest entry. */
  readonly setFollowing: (following: boolean) => void;
  /** For the scroll box's `onScroll`. */
  readonly onScroll: () => void;
  readonly ref: RefObject<HTMLOListElement | null>;
}

/**
 * Keeps a scroll box at its newest entry until the user scrolls away (000.06).
 *
 * A scroll that leaves the box more than {@link AT_BOTTOM_PX} from the bottom
 * can only be the user's: this hook's own scroll always lands at the bottom.
 * `changed` is whatever identifies "new content" — the entries array, which is
 * replaced on every append and every streamed delta.
 */
export const useFollow = (changed: unknown): Follow => {
  const ref = useRef<HTMLOListElement | null>(null);
  const [following, setFollowing] = useState(true);

  useLayoutEffect(() => {
    const box = ref.current;
    if (following && box !== null) box.scrollTop = box.scrollHeight;
  }, [changed, following]);

  return {
    following,
    setFollowing,
    ref,
    onScroll: () => {
      const box = ref.current;
      if (box === null) return;
      const gap = box.scrollHeight - box.scrollTop - box.clientHeight;
      if (gap > AT_BOTTOM_PX) setFollowing(false);
    },
  };
};
