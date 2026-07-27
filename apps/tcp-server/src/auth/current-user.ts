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
