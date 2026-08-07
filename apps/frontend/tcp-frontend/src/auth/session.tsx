import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { SessionContext, useSession, type Session } from './useSession';

/**
 * Supplies the session to the tree.
 *
 * The `session` prop is the seam, in two directions at once. {@link AuthSession}
 * derives the real session from the token client (ADR-024) and supplies it
 * here; the prop is what stands in when there is no signed-in user, which is
 * where `?devSession=` lands.
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
 * The attempted path is carried in location state, and the landing page hands it
 * to sign-in so the user comes back to it. A destination read out of history is
 * attacker-influenced, so {@link safeRedirectTarget} validates it on the way
 * back and is the only code that dereferences it. Nothing here does, and
 * nothing here should start to.
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
