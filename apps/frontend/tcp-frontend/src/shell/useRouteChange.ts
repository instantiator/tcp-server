import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';
import { ANNOUNCE_IMMEDIATE_MS, announce } from '../announce/announcer';

/**
 * Moves focus to the page's main heading on every route change, and asks the
 * announcer to say where the user has arrived (ADR-027).
 *
 * Route change is one of exactly four points at which this application moves
 * focus. Don't add a fifth here.
 *
 * Three deliberate choices:
 *
 * - **Not on first render.** Arriving at a URL is not a route change, and
 *   yanking focus out of the document on load is worse than the browser's own
 *   starting position. The guard remembers the last path it *acted on* rather
 *   than whether it has run before, because `StrictMode` invokes an effect
 *   twice on mount: a "have I run?" flag is spent by the first invocation and
 *   the second one then fires on arrival. Keying on the value that actually
 *   changed is immune to being called again for the same navigation.
 * - **`tabIndex` is set here rather than declared on each page's `h1`.** A page
 *   that forgot the attribute would fail silently — `focus()` on a
 *   non-focusable element does nothing and throws nothing — so the one place
 *   that needs it is the one place that sets it. `-1` makes the heading
 *   programmatically focusable without adding a tab stop.
 * - **The heading is found in the document, not through a ref.** A ref would
 *   have to be threaded through every page and every layout to reach here, and
 *   what is being focused is defined by the rendered document rather than by
 *   the component tree.
 *
 * The announcement does not wait for a throttle window: it follows a
 * deliberate action, and the user is standing still until they know where they
 * are. Two consecutive routes sharing a title announce twice, which is
 * correct — the announcer appends a fresh node per message rather than
 * mutating one whose unchanged text a screen reader would ignore.
 */
export const useRouteChange = (): void => {
  const { pathname } = useLocation();
  const actedOn = useRef(pathname);

  useEffect(() => {
    if (actedOn.current === pathname) return;
    actedOn.current = pathname;

    const heading = document.querySelector('h1');
    if (heading !== null) {
      heading.tabIndex = -1;
      heading.focus();
    }

    announce({
      channel: 'route',
      change: 'announce.routeChange',
      params: { title: document.title },
      throttleMs: ANNOUNCE_IMMEDIATE_MS,
    });
  }, [pathname]);
};
