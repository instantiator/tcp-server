import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

window.__TCP_CONFIG__ = {
  oidcIssuerUrl: 'https://idp.example.com',
  oidcClientId: 'test-web-client',
};

/**
 * Re-imports the policy so its module-level "already redirecting" latch starts
 * empty, and spies on the real singleton rather than mocking the module — the
 * dedup behaviour under test is only meaningful against one shared manager.
 */
const loadPolicy = async () => {
  vi.resetModules();
  const { getUserManager } = await import('./user-manager');
  const { handleUnauthorized } = await import('./unauthorized');
  const signinRedirect = vi.spyOn(getUserManager(), 'signinRedirect');
  return { handleUnauthorized, signinRedirect };
};

describe('handleUnauthorized', () => {
  let handleUnauthorized: () => Promise<void>;
  let signinRedirect: MockInstance;

  beforeEach(async () => {
    ({ handleUnauthorized, signinRedirect } = await loadPolicy());
  });

  it('redirects once for a burst of 401s', async () => {
    // A token that has genuinely gone fails the open stream and every queued
    // request at the same moment. Unguarded, each caller starts its own
    // navigation.
    signinRedirect.mockResolvedValue(undefined);

    await Promise.all([
      handleUnauthorized(),
      handleUnauthorized(),
      handleUnauthorized(),
    ]);

    expect(signinRedirect).toHaveBeenCalledTimes(1);
  });

  it('carries the attempted location for 004.02 to return to', async () => {
    signinRedirect.mockResolvedValue(undefined);
    history.replaceState({}, '', '/company/abc?tab=activity');

    await handleUnauthorized();

    expect(signinRedirect).toHaveBeenCalledWith(
      expect.objectContaining({
        state: { from: '/company/abc?tab=activity' },
      }),
    );
  });

  it('does not latch when the navigation never started', async () => {
    // A misconfigured authority rejects before the browser leaves the page.
    // Holding the failed promise would make every later 401 resolve instantly
    // against it, and the user would never be sent to sign in.
    signinRedirect.mockRejectedValueOnce(new Error('no metadata'));
    signinRedirect.mockResolvedValue(undefined);

    await expect(handleUnauthorized()).rejects.toThrow('no metadata');
    await handleUnauthorized();

    expect(signinRedirect).toHaveBeenCalledTimes(2);
  });
});
