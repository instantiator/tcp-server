import { getUserManager } from './user-manager';

/**
 * The one in-flight redirect, if any. Not cleared on success: the page is
 * navigating away, and the promise never settles from the caller's point of
 * view.
 */
let redirecting: Promise<void> | null = null;

/**
 * What happens when the API rejects the token — the single policy the fetch
 * wrapper (005.01) and the stream reader (005.02) both call (ADR-024).
 *
 * One full-page redirect to the provider. It is both halves of "renew, then
 * sign in": this client holds no refresh token, so there is nothing to renew
 * with, and the redirect is what a renewal would have been. Against a live
 * provider session the user returns with a fresh token and never sees a form;
 * against an expired one they see the login page. The provider decides, and
 * the client does not have to guess which case it is in.
 *
 * Deduplicated, because a 401 rarely arrives alone: a token that has gone
 * fails the stream and every queued request at once, and each unguarded caller
 * would start its own navigation. The first one wins and the rest wait on it.
 *
 * The attempted location travels in `state` for the callback route to return
 * the user to, in the same `{ from }` shape `RequireSession` uses. It is
 * round-tripped through the provider and comes back attacker-influenced;
 * {@link safeRedirectTarget} is what refuses to follow it blindly, and is the
 * only place that should. Note the query string, which `RequireSession`'s does
 * not carry — a validator matching bare route paths would discard it.
 */
export const handleUnauthorized = (): Promise<void> =>
  (redirecting ??= getUserManager()
    .signinRedirect({
      state: { from: window.location.pathname + window.location.search },
    })
    .catch((error: unknown) => {
      // The navigation never started — a misconfigured authority, or an
      // unreachable discovery document. Clear the latch so a later 401 can try
      // again rather than resolving instantly against a dead promise.
      redirecting = null;
      throw error;
    }));
