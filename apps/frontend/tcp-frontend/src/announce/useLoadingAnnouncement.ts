import { useEffect, useRef } from 'react';
import {
  ANNOUNCE_LOADING_MIN_MS,
  announce,
  type Announcement,
} from './announcer';

/**
 * Announces that a wait has finished — and only if it was long enough to be
 * worth mentioning (ADR-027: completion only, over ~1s).
 *
 * Starting is never announced. The user asked for it, so being told it has
 * begun says nothing they don't know, and saying it interrupts them on every
 * interaction.
 *
 * **There is no "have I run?" state here, deliberately.** `StrictMode` invokes
 * an effect twice on mount, which spends a boolean flag on the first
 * invocation and leaves the second one to fire on arrival — the bug 003.02
 * shipped in the route-change hook, green in every jsdom test because the test
 * helper did not use `StrictMode` at the time. This hook has nothing to spend:
 * the only path that announces is the falling edge of a wait that already
 * started, and on mount no wait has started, so a second invocation reaches
 * the same conclusion as the first.
 *
 * **Pass `null` for `completion` when the wait did not end in success.** A
 * failed request stops loading just as a successful one does, so a caller that
 * always supplies an announcement gets two for one event: `ErrorState`'s
 * assertive "Error: …" and a polite "…loaded" that isn't true. The caller knows
 * the outcome and this hook does not, which is why the decision is theirs —
 * `error === null ? { … } : null` at the call site.
 */
export const useLoadingAnnouncement = (
  loading: boolean,
  completion: Announcement | null,
): void => {
  // When the current state began. Read before it is overwritten, so a wait
  // is measured from when it started rather than from when it ended.
  const startedAt = useRef(Date.now());

  // Held in a ref so the effect can depend on `loading` alone. A caller that
  // builds `completion` inline passes a new object every render, which would
  // otherwise re-run the effect on renders where nothing loaded or finished.
  const latest = useRef(completion);
  latest.current = completion;

  useEffect(() => {
    const since = startedAt.current;
    startedAt.current = Date.now();

    if (loading) return;
    if (latest.current === null) return;
    if (Date.now() - since < ANNOUNCE_LOADING_MIN_MS) return;

    announce(latest.current);
  }, [loading]);
};
