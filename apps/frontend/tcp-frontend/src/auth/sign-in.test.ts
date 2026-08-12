import { beforeEach, describe, expect, it, vi } from 'vitest';
import { startSignIn } from './sign-in';
import { getUserManager } from './user-manager';

// Spying on the real singleton rather than mocking the module: what is under
// test is the arguments handed to the one shared client, and a mocked module
// would assert the call this file makes to itself.
const signinRedirect = vi.spyOn(getUserManager(), 'signinRedirect');

describe('startSignIn', () => {
  beforeEach(() => {
    signinRedirect.mockReset();
    signinRedirect.mockResolvedValue(undefined);
  });

  it('carries the attempted destination through the provider', async () => {
    // The same `{ from }` shape `RequireSession` puts in the location state and
    // `handleUnauthorized()` builds by hand — passed through, not rewrapped.
    // Rewrapping is exactly the bug `safeRedirectTarget` cannot see: it would
    // read an object where it expects a path and quietly send everyone to the
    // default.
    await startSignIn({ from: '/company/acme?tab=activity' });

    expect(signinRedirect).toHaveBeenCalledWith({
      state: { from: '/company/acme?tab=activity' },
    });
  });

  it('starts a sign-in with no destination when there is none to carry', async () => {
    await startSignIn();

    expect(signinRedirect).toHaveBeenCalledWith({ state: undefined });
  });

  it('does not validate the destination on the way out', async () => {
    // Validation happens on the way back, in `safeRedirectTarget`. Checking
    // here as well would look reassuring and protect nothing: the value makes a
    // round trip through the provider, and an attacker who can influence it can
    // influence what comes back regardless of what left.
    await startSignIn({ from: 'https://evil.example/' });

    expect(signinRedirect).toHaveBeenCalledWith({
      state: { from: 'https://evil.example/' },
    });
  });

  it('rejects rather than swallowing a navigation that never started', async () => {
    // The landing page shows a message on this. Swallowed, it is a button that
    // does nothing and says nothing.
    signinRedirect.mockRejectedValueOnce(new Error('no metadata'));

    await expect(startSignIn()).rejects.toThrow('no metadata');
  });
});
