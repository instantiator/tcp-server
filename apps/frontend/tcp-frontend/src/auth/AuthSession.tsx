import type { ReactNode } from 'react';
import { useAuth } from 'react-oidc-context';
import { SessionProvider } from './session';
import type { Session } from './useSession';

/**
 * Turns the OIDC user into the {@link Session} the shell reads.
 *
 * The OIDC user always wins; `fallback` is only what stands in when there is
 * none. That ordering is the point rather than a detail: `main.tsx` passes
 * `?devSession=`'s stand-in and the test tier passes a literal, and neither may
 * displace a real signed-in user — nor, once 004.03 puts a token behind the
 * session, imply one that does not exist.
 *
 * 004.02 derives the session here rather than leaving it to 004.03 because
 * without it the callback route navigates to a guarded page, `RequireSession`
 * sees no session and sends the user back to `/`, and signing in bounces
 * straight back to the sign-in control.
 */
export const AuthSession = ({
  fallback = null,
  children,
}: {
  readonly fallback?: Session | null;
  readonly children: ReactNode;
}) => {
  const { isAuthenticated, user } = useAuth();
  // `isAuthenticated` is the library's own "there is a user and it has not
  // expired"; reading `user` alone would keep the header signed in against a
  // token the API has already started refusing.
  const userId = isAuthenticated ? user?.profile.sub : undefined;

  return (
    <SessionProvider session={userId === undefined ? fallback : { userId }}>
      {children}
    </SessionProvider>
  );
};
