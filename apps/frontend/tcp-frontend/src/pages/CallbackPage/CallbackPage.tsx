import { ErrorResponse } from 'oidc-client-ts';
import { useAuth, type AuthContextProps } from 'react-oidc-context';
import { Link, Navigate } from 'react-router';
import { safeRedirectTarget } from '../../auth/redirect-target';
import { startSignIn } from '../../auth/sign-in';
import { ErrorState } from '../../components/ErrorState/ErrorState';
import { LoadingState } from '../../components/LoadingState/LoadingState';
import { useDocumentTitle } from '../../shell/useDocumentTitle';
import { t, type StringKey } from '../../strings';

/** The announcer channel for everything in the sign-in journey. */
const AUTH_CHANNEL = 'auth';

/**
 * Which failure the user is looking at.
 *
 * No error and no user means the page was opened on its own: `AuthProvider`
 * only attempts an exchange when the address carries authorization parameters,
 * so reaching the end of it with neither is someone typing `/callback`.
 *
 * A replayed callback lands in `callback.error.failed` alongside a genuine
 * provider error, deliberately. Its underlying message is "No matching state
 * found in storage", and the user's next action is the same in both cases —
 * naming the second would be describing our storage to them.
 */
const errorKey = (error: AuthContextProps['error']): StringKey => {
  if (error === undefined) return 'callback.error.direct';

  return error.innerError instanceof ErrorResponse &&
    error.innerError.error === 'access_denied'
    ? 'callback.error.cancelled'
    : 'callback.error.failed';
};

/**
 * Where the identity provider returns the user.
 *
 * **It exchanges nothing itself.** `AuthProvider` has already called
 * `signinCallback()` by the time this renders, behind a ref that survives
 * StrictMode's double mount, so a second exchange here would fail against the
 * same single-use code and report an error for a sign-in that worked.
 *
 * **And nothing on this page redirects to the provider on its own.** Every
 * route back out is a control someone pressed. That is what makes a redirect
 * loop impossible rather than unlikely: a failing callback that re-attempted
 * sign-in would bounce between here and the provider with nothing in the way.
 *
 * It renders outside the application shell and owns its own `main`, as the
 * landing page does — the user arriving here has no session yet, and a header
 * flashing its signed-out state on the way past is worse than no header.
 */
export const CallbackPage = () => {
  useDocumentTitle(t('page.callback.title'));
  const auth = useAuth();

  if (auth.isAuthenticated) {
    // `replace`, so the address carrying the authorization code does not stay
    // in the history for the back button — or a reload — to replay.
    return <Navigate to={safeRedirectTarget(auth.user?.state)} replace />;
  }

  const key = auth.isLoading ? undefined : errorKey(auth.error);

  return (
    <main className="callback-page">
      <h1>{t('page.callback.title')}</h1>

      {key === undefined ? (
        <LoadingState label={t('callback.loading')} />
      ) : (
        <>
          <ErrorState
            message={t(key)}
            channel={AUTH_CHANNEL}
            // Nothing to retry when the page was opened directly: there was no
            // sign-in attempt to repeat, only an address someone typed.
            onRetry={
              key === 'callback.error.direct'
                ? undefined
                : () => {
                    void startSignIn();
                  }
            }
          />
          {/* A way out that never involves the provider, in every failure. */}
          <Link to="/">{t('page.notFound.home')}</Link>
        </>
      )}
    </main>
  );
};
