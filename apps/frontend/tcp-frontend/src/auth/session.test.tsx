import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { User } from 'oidc-client-ts';
import { describe, expect, it, vi } from 'vitest';
import { t } from '../strings';
import { expectNoA11yViolations } from '../test-support/axe';

/** The claims oidc-client-ts requires on a `User`, matching test-setup.ts's config. */
const profile = {
  sub: 'user-1',
  iss: 'https://identity.test/',
  aud: 'tcp-web-test',
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

/**
 * Fresh copies of the manager and the render helper, so each test's
 * `handleUnauthorized` latch starts empty (`unauthorized.test.ts`'s pattern).
 * `RequireSession` calls that policy on every mount with no session, which is
 * most of the tests below — reusing one module graph across them would let an
 * earlier test's redirect answer a later test's assertion.
 *
 * Both are re-imported together, in the same `resetModules` cycle, so
 * `renderAppAtUrl`'s own import of `getUserManager` resolves to the identical
 * singleton this returns — a stale reference to either would watch a
 * `signinRedirect` that never happens to be the one under test.
 */
const freshRecoveryStack = async () => {
  vi.resetModules();
  const { getUserManager } = await import('./user-manager');
  const { renderAppAtUrl } = await import('../test-support/render-app');
  const manager = getUserManager();
  const signinRedirect = vi.spyOn(manager, 'signinRedirect');
  return { manager, renderAppAtUrl, signinRedirect };
};

describe('RequireSession', () => {
  it('renders the protected route directly when a stored user is still valid', async () => {
    // Reload recovery's happy path: the provider is never asked, because
    // there was nothing lost to recover.
    const { manager, renderAppAtUrl, signinRedirect } =
      await freshRecoveryStack();
    await manager.storeUser(signedInUser());

    renderAppAtUrl('/companies');

    expect(
      await screen.findByRole('heading', { name: t('page.companies.title') }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: t('landing.signIn') }),
    ).toBeNull();
    expect(signinRedirect).not.toHaveBeenCalled();
  });

  it('recovers with exactly one redirect when there is no stored user', async () => {
    const { renderAppAtUrl, signinRedirect } = await freshRecoveryStack();
    // Never resolves: real navigation would leave the page, and this proves
    // the loading state is what shows up to that point rather than a flash.
    signinRedirect.mockReturnValue(new Promise(() => undefined));

    renderAppAtUrl('/companies');

    expect(
      await screen.findByRole('progressbar', {
        name: t('state.loading', { label: t('session.recovering') }),
      }),
    ).toBeInTheDocument();
    expect(signinRedirect).toHaveBeenCalledTimes(1);
    // No navigation happened locally — the redirect is the provider's, not
    // React Router's, and this client never bounces to the landing page.
    expect(window.location.pathname).toBe('/companies');
  });

  describe('the redirect loop', () => {
    it('never redirects to the provider on its own', async () => {
      // The characteristic failure of this guard: an unreachable provider
      // re-attempting the redirect would bounce forever with nothing in the
      // way. Every route back out has to be a control someone pressed.
      const { renderAppAtUrl, signinRedirect } = await freshRecoveryStack();
      signinRedirect.mockRejectedValue(new Error('discovery unreachable'));

      renderAppAtUrl('/companies');

      await screen.findByText(t('session.recovery.failed'));
      expect(signinRedirect).toHaveBeenCalledTimes(1);
      expect(window.location.pathname).toBe('/companies');

      // Give the mounted tree room to do the wrong thing before concluding it
      // did not: the assertion above would pass against a redirect scheduled
      // one tick later.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(signinRedirect).toHaveBeenCalledTimes(1);
    });

    it('redirects exactly once more, and only when the user presses retry', async () => {
      const { renderAppAtUrl, signinRedirect } = await freshRecoveryStack();
      signinRedirect.mockRejectedValueOnce(new Error('discovery unreachable'));
      signinRedirect.mockResolvedValue(undefined);
      const user = userEvent.setup();

      renderAppAtUrl('/companies');
      await screen.findByText(t('session.recovery.failed'));
      expect(signinRedirect).toHaveBeenCalledTimes(1);

      await user.click(
        screen.getByRole('button', { name: t('state.error.retry') }),
      );

      expect(signinRedirect).toHaveBeenCalledTimes(2);
    });
  });

  it('never shows the protected page to a signed-out visitor arriving at its address', async () => {
    // Stands in for reaching a guarded route by a back-navigation or a typed
    // address with no session: whatever got the browser here, the content
    // behind the guard must not render while recovery is still deciding.
    const { renderAppAtUrl, signinRedirect } = await freshRecoveryStack();
    signinRedirect.mockReturnValue(new Promise(() => undefined));

    renderAppAtUrl('/companies');

    await screen.findByRole('progressbar', {
      name: t('state.loading', { label: t('session.recovering') }),
    });
    expect(
      screen.queryByRole('heading', { name: t('page.companies.title') }),
    ).toBeNull();
  });

  describe('accessibility', () => {
    it('has no violations while recovering', async () => {
      const { renderAppAtUrl, signinRedirect } = await freshRecoveryStack();
      signinRedirect.mockReturnValue(new Promise(() => undefined));

      const { container } = renderAppAtUrl('/companies');

      await screen.findByRole('progressbar', {
        name: t('state.loading', { label: t('session.recovering') }),
      });
      await expectNoA11yViolations(container);
    });

    it('has no violations once recovery has failed', async () => {
      const { renderAppAtUrl, signinRedirect } = await freshRecoveryStack();
      signinRedirect.mockRejectedValue(new Error('discovery unreachable'));

      const { container } = renderAppAtUrl('/companies');

      await screen.findByText(t('session.recovery.failed'));
      await expectNoA11yViolations(container);
    });
  });
});
