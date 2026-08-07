import { render, screen } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { AuthProvider } from 'react-oidc-context';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthSession } from './AuthSession';
import { getUserManager } from './user-manager';
import { useSession, type Session } from './useSession';

window.__TCP_CONFIG__ = {
  oidcIssuerUrl: 'https://idp.example.com',
  oidcClientId: 'test-web-client',
};

const profile = {
  sub: 'real-user',
  iss: 'https://idp.example.com',
  aud: 'test-web-client',
  exp: 0,
  iat: 0,
};

const signedInUser = () =>
  new User({
    access_token: 'test-access-token',
    token_type: 'Bearer',
    profile,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });

const FALLBACK: Session = { userId: 'dev-admin' };

/** Reads whatever `AuthSession` derived, the way the shell would. */
const SessionProbe = () => {
  const session = useSession();
  return <p>{session === null ? 'signed out' : session.userId}</p>;
};

const renderAuthSession = (fallback: Session | null, children: ReactNode) =>
  render(
    <AuthProvider userManager={getUserManager()}>
      <AuthSession fallback={fallback}>{children}</AuthSession>
    </AuthProvider>,
  );

describe('AuthSession', () => {
  afterEach(async () => {
    await getUserManager().removeUser();
  });

  it('lets a real OIDC user displace the ?devSession= fallback', async () => {
    // This is the property that stops `?devSession=admin` becoming a local
    // privilege escalation the day `Session` carries a token: a signed-in
    // user must always win over the fallback, never the other way round. It
    // is one refactor — reversing the ternary below — from silently
    // inverting, which is why it gets a test of its own rather than trusting
    // the "fallback used when there is no user" case to cover it by omission.
    await getUserManager().storeUser(signedInUser());

    renderAuthSession(FALLBACK, <SessionProbe />);

    expect(await screen.findByText('real-user')).toBeInTheDocument();
    expect(screen.queryByText('dev-admin')).toBeNull();
  });

  it('uses the fallback when there is no OIDC user', async () => {
    renderAuthSession(FALLBACK, <SessionProbe />);

    expect(await screen.findByText('dev-admin')).toBeInTheDocument();
  });

  it('clears the session when the user is unloaded', async () => {
    await getUserManager().storeUser(signedInUser());
    renderAuthSession(null, <SessionProbe />);
    expect(await screen.findByText('real-user')).toBeInTheDocument();

    await getUserManager().removeUser();

    expect(await screen.findByText('signed out')).toBeInTheDocument();
  });
});
