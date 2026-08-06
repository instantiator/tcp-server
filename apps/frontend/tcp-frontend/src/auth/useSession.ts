import { createContext, use } from 'react';

/**
 * Who is signed in. Deliberately the smallest thing the shell needs — the
 * header greets nobody, and 008.06's profile dialog reads the ID token's claims
 * directly rather than through this (ADR-023: there is no `/api/me`).
 */
export interface Session {
  /** The OIDC `sub` claim: the stable identifier for this user. */
  userId: string;
}

/**
 * Held here rather than in `session.tsx` so that file exports nothing but
 * components — `react-refresh/only-export-components` is an error in this
 * workspace, and a mixed module breaks fast refresh during development. The
 * theme context is split the same way, for the same reason.
 *
 * `null` means signed out, which is every session in the application until
 * 004.03 fills the provider in.
 */
export const SessionContext = createContext<Session | null>(null);

/** The current session, or `null` when signed out. */
export const useSession = (): Session | null => use(SessionContext);
