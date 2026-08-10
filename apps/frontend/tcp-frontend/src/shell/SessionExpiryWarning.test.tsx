import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { User } from 'oidc-client-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../auth/session';
import { getUserManager } from '../auth/user-manager';
import { t } from '../strings';
import { expectNoA11yViolations } from '../test-support/axe';
import { SessionExpiryWarning } from './SessionExpiryWarning';

window.__TCP_CONFIG__ = {
  oidcIssuerUrl: 'https://idp.example.com',
  oidcClientId: 'test-web-client',
};

const profile = {
  sub: 'test-user',
  iss: 'https://idp.example.com',
  aud: 'test-web-client',
  exp: 0,
  iat: 0,
};

const SIGNED_IN = { userId: 'test-user' };

/**
 * Stores a user and arms the manager's expiry timers the way a real mount
 * does. `storeUser` only persists to the in-memory store; it is `getUser()` —
 * what `AuthProvider` calls on every mount — that hands the user to
 * `AccessTokenEvents` and starts its timers. There is no public method on
 * `oidc-client-ts` that raises `accessTokenExpiring` directly, so this and
 * fake timers are the honest way to provoke it (confirmed by reading
 * `AccessTokenEvents`/`Timer` in the library before writing this).
 */
const armWithExpiryIn = async (seconds: number) => {
  await getUserManager().storeUser(
    new User({
      access_token: 'test-access-token',
      token_type: 'Bearer',
      profile,
      expires_at: Math.floor(Date.now() / 1000) + seconds,
    }),
  );
  await getUserManager().getUser();
};

/** 35 seconds out is outside the 30-second window; the library schedules its
 * own timer for the 5 seconds remaining until the window opens, so advancing
 * by exactly that is what crosses into "expiring" rather than firing at once. */
const armAndAdvanceIntoTheWindow = async () => {
  await armWithExpiryIn(35);
  await vi.advanceTimersByTimeAsync(5_000);
};

/**
 * The warning is showing.
 *
 * Waited for rather than asserted straight after
 * {@link armAndAdvanceIntoTheWindow}. `expiring` is raised by the library's own
 * timer and then has to reach React, and under load — the whole suite running
 * at once — that had not always happened by the next line. It cannot go in the
 * helper itself: one test arms the window precisely to show that nothing
 * appears without a session.
 */
const expectWarningShown = () =>
  waitFor(() => {
    expect(warning()).not.toBeNull();
  });

const renderWarning = (session: { userId: string } | null = SIGNED_IN) =>
  render(
    <SessionProvider session={session}>
      <SessionExpiryWarning />
    </SessionProvider>,
  );

const warning = () =>
  screen.queryByRole('group', { name: t('session.expiry.label') });

describe('SessionExpiryWarning', () => {
  beforeEach(() => {
    // `shouldAdvanceTime` lets real awaits (rendering, userEvent, storing a
    // user) keep progressing while the manager's own timers stay under this
    // test's explicit control.
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await getUserManager().removeUser();
  });

  it('renders nothing by default', () => {
    renderWarning();

    expect(warning()).toBeNull();
  });

  it('appears when the manager raises accessTokenExpiring', async () => {
    renderWarning();

    await armAndAdvanceIntoTheWindow();

    await expectWarningShown();
    expect(screen.getByText(t('session.expiring'))).toBeInTheDocument();
  });

  it('hides again once the session is renewed (userLoaded)', async () => {
    renderWarning();
    await armAndAdvanceIntoTheWindow();
    await expectWarningShown();

    // A fresh, longer-lived user standing in for a renewal — loaded with
    // `raiseEvent`, because `storeUser` alone would not raise `userLoaded`.
    await getUserManager().storeUser(
      new User({
        access_token: 'renewed-access-token',
        token_type: 'Bearer',
        profile,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    await getUserManager().getUser(true);

    await waitFor(() => expect(warning()).toBeNull());
  });

  it('hides again once the session is removed (userUnloaded)', async () => {
    renderWarning();
    await armAndAdvanceIntoTheWindow();
    await expectWarningShown();

    await getUserManager().removeUser();

    await waitFor(() => expect(warning()).toBeNull());
  });

  it('renders nothing while expiring when there is no session', async () => {
    renderWarning(null);

    await armAndAdvanceIntoTheWindow();

    expect(warning()).toBeNull();
  });

  it('extends the session exactly once when "Stay signed in" is pressed', async () => {
    const signinRedirect = vi
      .spyOn(getUserManager(), 'signinRedirect')
      .mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderWarning();
    await armAndAdvanceIntoTheWindow();

    await user.click(
      screen.getByRole('button', { name: t('session.staySignedIn') }),
    );

    expect(signinRedirect).toHaveBeenCalledTimes(1);
  });

  it('announces the expiry assertively, exactly once', async () => {
    renderWarning();

    await armAndAdvanceIntoTheWindow();

    // `ErrorState`'s doc comment is the fuller explanation: ADR-027 allows
    // exactly one live region, and this component routes through it rather
    // than mounting `role="alert"` of its own.
    await waitFor(() => {
      const region = document.querySelector(
        '[data-live-announcer] [aria-live="assertive"]',
      );
      expect(region?.textContent).toBe(t('session.expiring.announcement'));
    });
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('has no accessibility violations while showing', async () => {
    // `container`, not `document.body`: this component renders in place
    // rather than portalling out, and scanning the whole document would
    // additionally check that page-level landmark structure — AppShell's,
    // not this component's — which is not what this test is about.
    const { container } = renderWarning();

    await armAndAdvanceIntoTheWindow();
    await screen.findByRole('group', { name: t('session.expiry.label') });

    await expectNoA11yViolations(container);
  });
});
