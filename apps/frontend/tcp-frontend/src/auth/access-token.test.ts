import { User } from 'oidc-client-ts';
import { afterEach, describe, expect, it } from 'vitest';
import { getAccessToken } from './access-token';
import { getUserManager } from './user-manager';

window.__TCP_CONFIG__ = {
  oidcIssuerUrl: 'https://idp.example.com',
  oidcClientId: 'test-web-client',
};

const profile = {
  sub: 'someone',
  iss: 'https://idp.example.com',
  aud: 'test-web-client',
  exp: 0,
  iat: 0,
};

/** A stored user holding `access_token`, valid unless `expires_at` says not. */
const storeUser = (access_token: string, expires_at?: number) =>
  getUserManager().storeUser(
    new User({ access_token, token_type: 'Bearer', profile, expires_at }),
  );

describe('getAccessToken', () => {
  afterEach(async () => {
    await getUserManager().removeUser();
  });

  it('returns null when nobody is signed in', async () => {
    await expect(getAccessToken()).resolves.toBeNull();
  });

  it('reads the current token, not the one that was there first', async () => {
    // The failure this exists for is silent and delayed: an implementation
    // that captured a token — at module scope, or in a component that
    // mounted once — keeps returning it after renewal. Requests get a
    // puzzling 401, and a stream that reconnects on it does so for hours.
    await storeUser('FIRST-TOKEN');
    await expect(getAccessToken()).resolves.toBe('FIRST-TOKEN');

    await storeUser('SECOND-TOKEN');
    await expect(getAccessToken()).resolves.toBe('SECOND-TOKEN');
  });

  it('ignores an expired user', async () => {
    // Presenting a dead token produces a 401 the caller then has to
    // interpret; null is a fact it can act on directly.
    await storeUser('STALE-TOKEN', Math.floor(Date.now() / 1000) - 60);

    await expect(getAccessToken()).resolves.toBeNull();
  });

  it('presents a token whose expiry the provider did not state', async () => {
    // `expired` is undefined, not false, when there is no expires_at. A
    // truthiness check written the other way round would discard a perfectly
    // good token.
    await storeUser('UNDATED-TOKEN');

    await expect(getAccessToken()).resolves.toBe('UNDATED-TOKEN');
  });
});
