import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { SessionContext, useSession, type Session } from './useSession';

/**
 * Supplies the session to the tree.
 *
 * The `session` prop is the seam, in two directions at once. 004.03 replaces
 * this body with one that derives the session from the token client (ADR-024)
 * and drops the prop; until then the application mounts it with no session, so
 * every protected route redirects — which is correct, because there is no way
 * to sign in yet.
 *
 * And every component test from here on renders inside this shell, so passing a
 * literal session object is all that mocking a signed-in user ever needs to be.
 * No `vi.mock`, no fake token, no auth library in the tests.
 */
export const SessionProvider = ({
  session = null,
  children,
}: {
  session?: Session | null;
  children: ReactNode;
}) => <SessionContext value={session}>{children}</SessionContext>;

/**
 * The application's only access gate: a layout route rendering its children
 * when there is a session, and sending the visitor to the landing page when
 * there is not.
 *
 * `replace`, so the protected URL does not stay in the history — otherwise the
 * back button walks straight back into the redirect.
 *
 * The attempted path is carried in location state for 004.02, which returns the
 * user there after signing in. **That prompt must validate it before
 * navigating**: a destination read back out of history is attacker-influenced,
 * and following one unchecked is an open redirect. Nothing here dereferences
 * it, and nothing here should start to.
 */
export const RequireSession = () => {
  const session = useSession();
  const location = useLocation();

  return session === null ? (
    <Navigate to="/" replace state={{ from: location.pathname }} />
  ) : (
    <Outlet />
  );
};
