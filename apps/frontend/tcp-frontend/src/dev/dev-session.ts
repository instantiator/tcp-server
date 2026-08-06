import type { Session } from '../auth/useSession';

/** The query-string parameter that stands in for a signed-in user. */
export const DEV_SESSION_PARAM = 'devSession';

/**
 * Reads a stand-in session from the query string, so the signed-in shell can
 * be exercised before 004.02 builds real sign-in.
 *
 * **This is compiled out of a production build, not merely disabled in one.**
 * Vite replaces `import.meta.env.DEV` with the literal `false` at build time,
 * so the guard below becomes `if (true) return null` and everything after it
 * is unreachable code the minifier drops. The capability is absent from the
 * artefact rather than present and switched off — which is the only version of
 * this worth having, because a runtime flag is something an attacker can hope
 * to flip. `app-shell.spec.ts` proves it against the real deployment rather
 * than trusting that reasoning.
 *
 * What it grants is deliberately almost nothing. A `Session` today is a user
 * id and no more: it decides whether `RequireSession` renders or redirects,
 * and that is the whole of it. It carries no token, so every API call it leads
 * to is still refused with a 401 by tcp-server's own guard. It is a way to see
 * the header, not a way to reach data.
 *
 * **That stops being true the moment a session carries credentials.** When
 * 004.03 makes the session the thing that holds a bearer token, a session
 * built from a URL must not be able to mint one — the guard here protects the
 * production bundle, not a developer's own browser, and `?devSession=admin`
 * must never become a local privilege escalation. Written into that prompt.
 *
 * @param search A `window.location.search` string.
 * @returns The stand-in session, or `null` when absent or in production.
 */
export const readDevSession = (search: string): Session | null => {
  if (!import.meta.env.DEV) return null;

  const userId = new URLSearchParams(search).get(DEV_SESSION_PARAM)?.trim();
  if (userId === undefined || userId === '') return null;

  // Loud on purpose: a stand-in session is otherwise indistinguishable from
  // being genuinely signed in, and the difference matters the moment something
  // does not work the way it would in production.
  console.warn(
    `Using a development-only stand-in session for "${userId}", from ` +
      `?${DEV_SESSION_PARAM}. It carries no token, reaches no API, and does ` +
      `not exist in a production build.`,
  );

  return { userId };
};
