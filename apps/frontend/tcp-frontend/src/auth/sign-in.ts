import { getUserManager } from './user-manager';

/**
 * Starts the sign-in journey: a full-page redirect to the identity provider,
 * which returns the user to `/callback` (ADR-024).
 *
 * `state` rides along to the provider and comes back on the other side. It is
 * passed through untouched, and it is `{ from }` in every caller: the landing
 * page hands over whatever `RequireSession` put in the location state, and
 * `handleUnauthorized()` builds the same shape by hand. One shape end to end
 * means `safeRedirectTarget` is the only code that has to know it — and the
 * only code that has to distrust it.
 *
 * It is deliberately **not** validated here. Validation belongs on the way
 * back, where the value has been outside our control; a check on this side
 * would look reassuring and protect nothing.
 *
 * Returns the promise rather than swallowing it: `signinRedirect` rejects when
 * the navigation never starts at all — a misconfigured authority, an
 * unreachable discovery document — and a caller that cannot see that leaves the
 * user pressing a button that does nothing.
 */
export const startSignIn = (state?: unknown): Promise<void> =>
  getUserManager().signinRedirect({ state });
