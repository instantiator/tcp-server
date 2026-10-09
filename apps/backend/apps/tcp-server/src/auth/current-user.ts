import type { Request } from 'express';

/**
 * Extracts the JWT `sub` claim from an authenticated request's `req.user`
 * (populated by {@link JwtAuthGuard} / `jwt.strategy.ts`'s raw-payload
 * passthrough). Returns `null` when absent — used to populate
 * `Originators.user` for direct (non-agent) storage actions.
 */
export function getCurrentUserId(req: Request): string | null {
  const user = req.user as Record<string, unknown> | undefined;
  return typeof user?.sub === 'string' ? user.sub : null;
}

/**
 * The identifier forms a {@link CompanyUser} row may be keyed by: the OIDC
 * `sub` claim or an email address. Matching on `sub` alone silently misses
 * email-keyed memberships — the user sees an empty list and no error, which
 * is indistinguishable from not being a member of anything (ADR-023).
 *
 * May return `[]` for a token carrying neither claim; callers must treat that
 * as "a member of nothing", never as "unscoped".
 */
export function getCurrentUserIdentifiers(req: Request): string[] {
  const user = req.user as Record<string, unknown> | undefined;
  const claims = [user?.sub, user?.email];
  return [
    ...new Set(
      claims.filter(
        (claim): claim is string => typeof claim === 'string' && claim !== '',
      ),
    ),
  ];
}

/**
 * How to name the signed-in user to other users — for "Paused by …". Prefers
 * the token's display name, then its username or email, then the bare `sub`.
 */
export function getCurrentUserLabel(req: Request): string {
  const user = req.user as Record<string, unknown> | undefined;
  const label = [user?.name, user?.preferred_username, user?.email, user?.sub]
    .filter((claim): claim is string => typeof claim === 'string')
    .find((claim) => claim !== '');
  return label ?? 'a user';
}
