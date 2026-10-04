import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useAuth } from 'react-oidc-context';
import { Outlet } from 'react-router';
import { ErrorState } from '../components/ErrorState/ErrorState';
import { LoadingState } from '../components/LoadingState/LoadingState';
import { t } from '../strings';
import { handleUnauthorized } from './unauthorized';
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
 * when there is a session, and recovering one from the provider when there is
 * not.
 *
 * Recovery is the point of this component, and it is what makes a page reload
 * survivable. Tokens live in memory (ADR-024), so a reload always arrives here
 * with nothing — the same state as a visitor who was never signed in, and the
 * client cannot tell those apart. It does not have to: one full-page redirect
 * asks the provider, which returns a live session in a few hundred milliseconds
 * with no form, or shows a login form when the session has genuinely gone. Both
 * outcomes are correct, and neither is a bug to report.
 *
 * That redirect is {@link handleUnauthorized}, not a second path beside it.
 * There is no refresh token, so renewal and sign-in are the same navigation
 * (ADR-024 amendment (a)) — a page that has lost its token and a request that
 * was refused want exactly the same thing, and sharing the function shares the
 * deduplication latch and the `{ from }` state shape with it.
 *
 * ponytail: one attempt per page load, with no cross-load counter. The latch in
 * `handleUnauthorized` absorbs StrictMode's double mount and any second guarded
 * component; the `failed` guard stops the effect re-firing after a rejection,
 * which is the only way the latch reopens; and the provider's return leg always
 * lands on `/callback`, which never redirects on its own — so the two cannot
 * cycle. A counter goes in if a provider is ever seen returning a user with no
 * `sub`, or an already-expired one. See `docs/prompts/unresolved-notes.md`.
 *
 * Nothing here reads the attempted location. It travels in the redirect's
 * `state` and comes back attacker-influenced; {@link safeRedirectTarget} is the
 * only code that dereferences it, and nothing here should start to.
 */
export const RequireSession = () => {
  const session = useSession();
  const { isLoading } = useAuth();
  const [failed, setFailed] = useState(false);

  const recover = useCallback(() => {
    setFailed(false);
    handleUnauthorized().catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    // `isLoading` is the provider still restoring whatever it has. Deciding
    // before it finishes would send a signed-in user round the provider for
    // nothing, on every navigation into a guarded route.
    if (session !== null || isLoading || failed) return;

    recover();
  }, [session, isLoading, failed, recover]);

  if (session !== null) return <Outlet />;

  // The navigation never started — an unreachable authority, or a discovery
  // document that will not load. Retrying is the user's to choose: an automatic
  // one against a provider that is down is the redirect loop this component is
  // written to make impossible.
  if (failed) {
    return (
      <ErrorState
        message={t('session.recovery.failed')}
        channel="auth"
        onRetry={recover}
      />
    );
  }

  return <LoadingState label={t('session.recovering')} />;
};
