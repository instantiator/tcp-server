import { User, UserManager } from 'oidc-client-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUserManagerSettings, getUserManager } from './user-manager';

// Set before anything imports its way to getUserManager(), which memoises on
// first call and cannot be reconfigured afterwards.
window.__TCP_CONFIG__ = {
  oidcIssuerUrl: 'https://idp.example.com',
  oidcClientId: 'test-web-client',
};

/** The claims oidc-client-ts requires on a `User`, and nothing more. */
const profile = {
  sub: 'someone',
  iss: 'https://idp.example.com',
  aud: 'test-web-client',
  exp: 0,
  iat: 0,
};

describe('createUserManagerSettings', () => {
  it('requests the scopes the profile dialog needs', () => {
    const scopes = new Set(createUserManagerSettings().scope?.split(' '));

    expect(scopes).toContain('openid');
    expect(scopes).toContain('profile');
    expect(scopes).toContain('email');
  });

  it('never asks for a refresh token', () => {
    // ADR-024's threat model rests on this: an XSS gets whichever short-lived
    // access token is in memory when it runs, and never a credential that
    // outlives the page. Requesting offline_access would quietly undo that
    // while every other test here still passed.
    const scopes = new Set(createUserManagerSettings().scope?.split(' '));

    expect(scopes).not.toContain('offline_access');
  });

  it('derives its redirect URIs from the loaded origin', () => {
    const settings = createUserManagerSettings();

    expect(settings.redirect_uri).toBe(`${window.location.origin}/callback`);
    expect(settings.post_logout_redirect_uri).toBe(
      `${window.location.origin}/`,
    );
  });

  it('uses the authorization code flow', () => {
    expect(createUserManagerSettings().response_type).toBe('code');
  });

  it('warns 30 seconds before the access token expires', () => {
    // WCAG 2.2.1's floor for a timed session the user can extend is 20
    // seconds; 30 stays comfortably above it while keeping
    // SessionExpiryWarning close enough to expiry not to be noise. The
    // library's own default is 60.
    expect(
      createUserManagerSettings().accessTokenExpiringNotificationTimeInSeconds,
    ).toBe(30);
  });

  it('never renews through a hidden iframe', () => {
    // Both of these default to reaching for an iframe, which depends on the
    // provider's cookie being readable cross-origin. ADR-024 rejected the
    // mechanism outright, so a library default flipping back is a regression
    // nothing else would catch.
    const settings = createUserManagerSettings();

    expect(settings.automaticSilentRenew).toBe(false);
    expect(settings.monitorSession).toBe(false);
  });

  it('reads userinfo only when the runtime configuration asks for it', () => {
    expect(createUserManagerSettings().loadUserInfo).toBe(false);

    window.__TCP_CONFIG__ = {
      oidcIssuerUrl: 'https://idp.example.com',
      oidcClientId: 'test-web-client',
      oidcLoadUserInfo: true,
    };
    expect(createUserManagerSettings().loadUserInfo).toBe(true);

    // The string 'false' is what a hand-written config.js or an unquoted
    // shell interpolation gone wrong produces, and it is truthy. Reading it
    // as `true` would silently invert the default.
    window.__TCP_CONFIG__ = {
      oidcIssuerUrl: 'https://idp.example.com',
      oidcClientId: 'test-web-client',
      oidcLoadUserInfo: 'false' as unknown as boolean,
    };
    expect(createUserManagerSettings().loadUserInfo).toBe(false);

    window.__TCP_CONFIG__ = {
      oidcIssuerUrl: 'https://idp.example.com',
      oidcClientId: 'test-web-client',
    };
  });

  describe('token storage', () => {
    afterEach(() => {
      localStorage.clear();
      sessionStorage.clear();
    });

    it('writes no token to localStorage or sessionStorage', async () => {
      const manager = new UserManager(createUserManagerSettings());
      const secrets = ['ACCESS-TOKEN-XYZ', 'ID-TOKEN-XYZ', 'REFRESH-TOKEN-XYZ'];
      const [access_token, id_token, refresh_token] = secrets;

      await manager.storeUser(
        new User({
          access_token: access_token ?? '',
          id_token,
          refresh_token,
          token_type: 'Bearer',
          profile,
        }),
      );

      // The user really was stored. Without this the test also passes against
      // a manager that silently dropped it, which is not the property being
      // asserted.
      expect((await manager.getUser())?.access_token).toBe(access_token);

      // Every key and every value of both stores, matched as substrings
      // rather than by known key names: a library that renamed its storage
      // key, or added a second one, is still caught.
      const dump = [localStorage, sessionStorage]
        .flatMap((store) =>
          Array.from({ length: store.length }, (_, index) => {
            const key = store.key(index) ?? '';
            return `${key}=${store.getItem(key) ?? ''}`;
          }),
        )
        .join('\n');

      for (const secret of secrets) {
        expect(dump).not.toContain(secret);
      }
    });
  });
});

describe('getUserManager', () => {
  it('returns the same manager to every caller', () => {
    // Two managers would hold two different in-memory users, so the fetch
    // wrapper could present a token React had already replaced.
    expect(getUserManager()).toBe(getUserManager());
  });

  it('removes an expired user, because nothing else is watching', async () => {
    // `automaticSilentRenew` is off, so the library takes no action of its
    // own on expiry, and `react-oidc-context` recomputes `isAuthenticated`
    // only when something dispatches. The singleton's own
    // `addAccessTokenExpired` subscription is what stops the account menu
    // rendering against a token that has gone — this proves that
    // subscription is actually live, not just declared.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const manager = getUserManager();
      await manager.storeUser(
        new User({
          access_token: 'about-to-expire',
          token_type: 'Bearer',
          profile,
          expires_at: Math.floor(Date.now() / 1000) + 2,
        }),
      );
      // storeUser only persists; getUser() is what hands the user to
      // AccessTokenEvents and arms its timers — the same call AuthProvider
      // makes on mount.
      await manager.getUser();

      await vi.advanceTimersByTimeAsync(3_500);

      expect(await manager.getUser()).toBeNull();
    } finally {
      vi.useRealTimers();
      await getUserManager().removeUser();
    }
  });
});
