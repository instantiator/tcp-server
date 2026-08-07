import { matchPath } from 'react-router';

/**
 * Where a signed-in user lands when there was no saved destination, or the
 * saved one was not usable.
 *
 * A placeholder page until 006.01 replaces it with the real companies
 * overview; the constant is what that prompt confirms rather than hunts for.
 */
export const DEFAULT_SIGNED_IN_PATH = '/companies';

/**
 * The routes a returning user may be sent to: exactly the ones behind
 * `RequireSession` in `App.tsx`.
 *
 * `/` and `/callback` are deliberately absent — returning a freshly signed-in
 * user to either is the redirect loop this module exists to prevent — and so is
 * the catch-all, which matches every address and would make the allow-list
 * decorative.
 *
 * ponytail: hand-maintained beside the route table rather than derived from it.
 * A guarded route added later and not listed here loses the return-to-page
 * behaviour, which is an inconvenience rather than a hole. Derive both from one
 * array if the table outgrows a screenful.
 */
const RETURNABLE_ROUTES = ['/companies', '/company/:companyId'];

/**
 * The path to send a user to after signing in, given whatever came back in the
 * OIDC `state`.
 *
 * The input is attacker-influenced twice over: `RequireSession` and
 * {@link handleUnauthorized} both take it from the address bar, and it then
 * makes a round trip through the identity provider. Following one unchecked is
 * an open redirect, so this returns nothing but a path this application's own
 * route table declares — and falls back to {@link DEFAULT_SIGNED_IN_PATH}
 * rather than refusing, because a user who signed in successfully should not
 * be shown an error about where they were going.
 *
 * Parsed with `URL` rather than matched as a string, because the WHATWG parser
 * folds `\` into `/` for HTTP origins: `/\evil.example` becomes
 * `//evil.example` and fails the origin check, where a `startsWith('/')` test
 * would have waved it through. `javascript:` parses to a null origin and fails
 * the same check.
 */
export const safeRedirectTarget = (state: unknown): string => {
  const from =
    typeof state === 'object' && state !== null && 'from' in state
      ? state.from
      : undefined;

  if (typeof from !== 'string') return DEFAULT_SIGNED_IN_PATH;

  let url: URL;
  try {
    url = new URL(from, window.location.origin);
  } catch {
    return DEFAULT_SIGNED_IN_PATH;
  }

  if (url.origin !== window.location.origin) return DEFAULT_SIGNED_IN_PATH;

  // The query string travels with the path: `handleUnauthorized()` saves
  // `pathname + search`, so a validator returning bare paths would silently
  // discard half of what it was given.
  return RETURNABLE_ROUTES.some((route) => matchPath(route, url.pathname))
    ? url.pathname + url.search
    : DEFAULT_SIGNED_IN_PATH;
};
