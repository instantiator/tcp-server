import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startSignOut } from './sign-out';
import { getUserManager } from './user-manager';

window.__TCP_CONFIG__ = {
  oidcIssuerUrl: 'https://idp.example.com',
  oidcClientId: 'test-web-client',
};

// The real singleton, spied rather than mocked — `startSignOut` reaches it
// through `getUserManager()` itself, so intercepting the two calls it can
// make is intercepting the network at exactly the point it would be.
const manager = getUserManager();
const signoutRedirect = vi.spyOn(manager, 'signoutRedirect');
const removeUser = vi.spyOn(manager, 'removeUser');

describe('startSignOut', () => {
  // jsdom's `window.location.assign` is not configurable, so `vi.spyOn` fails
  // against it directly. Swapping the whole object for the duration of each
  // test, and putting the real one back straight after, is what lets the
  // fallback's navigation be observed without jsdom throwing or the test
  // actually navigating.
  const realLocation = window.location;
  let assign: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    signoutRedirect.mockReset();
    removeUser.mockReset();
    assign = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...realLocation, assign },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: realLocation,
    });
  });

  it('ends the session at the provider and does nothing else', async () => {
    signoutRedirect.mockResolvedValue(undefined);

    await startSignOut();

    expect(signoutRedirect).toHaveBeenCalledTimes(1);
    // `signoutRedirect()` removes the local user itself before it builds the
    // request (confirmed against the library before this was planned) —
    // there is nothing left for the fallback to do on the path that worked.
    expect(removeUser).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it('falls back to a local sign-out and the landing page when the provider redirect fails', async () => {
    // The case a provider with no end_session_endpoint hits: RP-initiated
    // logout is optional in OIDC, and Zitadel is not the only provider this
    // client will ever point at.
    signoutRedirect.mockRejectedValue(new Error('no end_session_endpoint'));
    removeUser.mockResolvedValue(undefined);

    await startSignOut();

    expect(removeUser).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('/');
  });

  it('never rejects, even when the provider redirect fails', async () => {
    // A menu item awaiting this promise must not throw for a user who is
    // about to land on the unguarded landing page regardless.
    signoutRedirect.mockRejectedValue(new Error('no end_session_endpoint'));
    removeUser.mockResolvedValue(undefined);

    await expect(startSignOut()).resolves.toBeUndefined();
  });
});
