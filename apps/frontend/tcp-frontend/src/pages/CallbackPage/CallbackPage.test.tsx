import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorResponse, User } from 'oidc-client-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getUserManager } from '../../auth/user-manager';
import { t } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import { fetchMock, installFetchMock } from '../../test-support/fetch-mock';
import { renderAppAtUrl } from '../../test-support/render-app';

// The real singleton, spied rather than mocked: `AuthProvider` is given this
// instance, so intercepting `signinCallback` is intercepting the provider
// exchange at exactly the point the network would be — and everything above it,
// including the session derivation, stays real.
const manager = getUserManager();
const signinCallback = vi.spyOn(manager, 'signinCallback');
const signinRedirect = vi.spyOn(manager, 'signinRedirect');

/**
 * What the provider hands back after a successful exchange.
 *
 * `userState` on the way in, `state` on the way out — the constructor argument
 * and the property do not share a name, and getting it wrong produces a user
 * with no destination rather than a type error.
 */
const signedInUser = (userState?: unknown) =>
  new User({
    access_token: 'test-access-token',
    token_type: 'Bearer',
    profile: {
      sub: 'user-1',
      iss: 'https://identity.test/',
      aud: 'tcp-web-test',
      exp: 0,
      iat: 0,
    },
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    userState,
  });

/** The address the provider returns a user to, with a code to exchange. */
const RETURNED = '/callback?code=test-code&state=test-state';

describe('CallbackPage', () => {
  beforeEach(() => {
    signinCallback.mockReset();
    signinRedirect.mockReset();
    signinRedirect.mockResolvedValue(undefined);
    // `AuthProvider` falls through to `getUser()` when there was nothing to
    // exchange. Left alone it would find whatever a previous test stored.
    vi.spyOn(manager, 'getUser').mockResolvedValue(null);

    // The page a completed sign-in lands on fetches (006.01). Answering the
    // company detail route with a named company is what lets the journey test
    // below assert the *destination* rather than only that some page rendered.
    installFetchMock();
    fetchMock.mockImplementation((input) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = url.endsWith('/api/company/acme')
        ? JSON.stringify({ id: 'acme', slug: 'acme', name: 'Acme Corporation' })
        : '[]';
      return Promise.resolve(
        new Response(body, {
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('a successful return', () => {
    it('completes the journey and lands on the saved destination', async () => {
      signinCallback.mockResolvedValue(
        signedInUser({ from: '/company/acme?tab=activity' }),
      );

      renderAppAtUrl(RETURNED);

      // The company page renders only behind `RequireSession`, and it titles
      // itself from the company the route parameter names — so this one
      // assertion is the whole journey: the code was exchanged, the session was
      // derived from the user, the saved destination was honoured, and the
      // company it pointed at was the one fetched.
      expect(
        await screen.findByRole('heading', {
          name: 'Acme Corporation',
          level: 1,
        }),
      ).toBeInTheDocument();
    });

    it('lands on the default destination when nothing was saved', async () => {
      signinCallback.mockResolvedValue(signedInUser());

      renderAppAtUrl(RETURNED);

      expect(
        await screen.findByRole('heading', { name: t('page.companies.title') }),
      ).toBeInTheDocument();
    });

    it('refuses a destination outside this application', async () => {
      // The open-redirect gate, exercised through the real journey rather than
      // only through `safeRedirectTarget`'s own unit test — this is the path
      // that would actually navigate.
      signinCallback.mockResolvedValue(
        signedInUser({ from: 'https://evil.example/companies' }),
      );

      renderAppAtUrl(RETURNED);

      expect(
        await screen.findByRole('heading', { name: t('page.companies.title') }),
      ).toBeInTheDocument();
      expect(window.location.origin).toBe('http://localhost:3000');
    });

    it('leaves the authorization code out of the history', async () => {
      // `replace`, not `push`: a back button or a reload that returned here
      // would replay a single-use code and fail a sign-in that worked.
      signinCallback.mockResolvedValue(signedInUser());

      renderAppAtUrl(RETURNED);

      await screen.findByRole('heading', { name: t('page.companies.title') });
      expect(window.location.pathname).toBe('/companies');
      expect(window.location.search).toBe('');
    });
  });

  describe('failures', () => {
    it('says so when the user cancelled at the provider', async () => {
      signinCallback.mockRejectedValue(
        new ErrorResponse({ error: 'access_denied' }),
      );

      renderAppAtUrl(RETURNED);

      expect(
        await screen.findByText(t('callback.error.cancelled')),
      ).toBeInTheDocument();
    });

    it('says so when the provider returned an error', async () => {
      signinCallback.mockRejectedValue(
        new ErrorResponse({ error: 'server_error' }),
      );

      renderAppAtUrl(RETURNED);

      expect(
        await screen.findByText(t('callback.error.failed')),
      ).toBeInTheDocument();
    });

    it('says so when the callback is replayed', async () => {
      // The second arrival for one code: the verifier and nonce were consumed
      // by the first, so there is nothing left in storage to match against.
      signinCallback.mockRejectedValue(
        new Error('No matching state found in storage'),
      );

      renderAppAtUrl(RETURNED);

      expect(
        await screen.findByText(t('callback.error.failed')),
      ).toBeInTheDocument();
    });

    it('says so when the page is opened on its own', async () => {
      renderAppAtUrl('/callback');

      expect(
        await screen.findByText(t('callback.error.direct')),
      ).toBeInTheDocument();
      // Nothing was attempted, so there is nothing to retry — only an address
      // someone typed.
      expect(signinCallback).not.toHaveBeenCalled();
      expect(
        screen.queryByRole('button', { name: t('state.error.retry') }),
      ).toBeNull();
    });

    it.each([
      ['a code with no state', '/callback?code=test-code'],
      ['a state with no code', '/callback?state=test-state'],
      ['an empty query', '/callback?'],
    ])('says so for %s', async (_case, url) => {
      renderAppAtUrl(url);

      expect(
        await screen.findByText(t('callback.error.direct')),
      ).toBeInTheDocument();
    });

    it('always offers a way out that does not involve the provider', async () => {
      signinCallback.mockRejectedValue(
        new ErrorResponse({ error: 'server_error' }),
      );

      renderAppAtUrl(RETURNED);

      expect(
        await screen.findByRole('link', { name: t('page.notFound.home') }),
      ).toHaveAttribute('href', '/');
    });
  });

  describe('the redirect loop', () => {
    it('never redirects to the provider on its own', async () => {
      // The characteristic failure of this journey: a callback that re-attempts
      // sign-in bounces between here and the provider with nothing in the way.
      // Every route back out has to be a control someone pressed.
      signinCallback.mockRejectedValue(
        new ErrorResponse({ error: 'server_error' }),
      );

      renderAppAtUrl(RETURNED);

      await screen.findByText(t('callback.error.failed'));
      expect(signinRedirect).not.toHaveBeenCalled();
      expect(window.location.pathname).toBe('/callback');

      // Give the mounted tree room to do the wrong thing before concluding it
      // did not: the assertion above would pass against a redirect scheduled
      // one tick later.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(signinRedirect).not.toHaveBeenCalled();
    });

    it('redirects exactly once when the user asks it to', async () => {
      const user = userEvent.setup();
      signinCallback.mockRejectedValue(
        new ErrorResponse({ error: 'server_error' }),
      );

      renderAppAtUrl(RETURNED);
      await screen.findByText(t('callback.error.failed'));

      await user.click(
        screen.getByRole('button', { name: t('state.error.retry') }),
      );

      expect(signinRedirect).toHaveBeenCalledTimes(1);
    });
  });

  it('is operable by keyboard alone', async () => {
    const user = userEvent.setup();
    signinCallback.mockRejectedValue(
      new ErrorResponse({ error: 'access_denied' }),
    );

    renderAppAtUrl(RETURNED);
    await screen.findByText(t('callback.error.cancelled'));

    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: t('state.error.retry') }),
    );

    await user.keyboard('{Enter}');
    expect(signinRedirect).toHaveBeenCalledTimes(1);

    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole('link', { name: t('page.notFound.home') }),
    );
  });

  describe('accessibility', () => {
    it('has no violations while the exchange is in flight', async () => {
      // A slow connection is the case a user actually sees this state in.
      signinCallback.mockReturnValue(new Promise(() => undefined));

      const { container } = renderAppAtUrl(RETURNED);

      expect(
        await screen.findByRole('progressbar', {
          name: t('state.loading', { label: t('callback.loading') }),
        }),
      ).toBeInTheDocument();
      await expectNoA11yViolations(container);
    });

    it('has no violations once it has failed', async () => {
      signinCallback.mockRejectedValue(
        new ErrorResponse({ error: 'server_error' }),
      );

      const { container } = renderAppAtUrl(RETURNED);

      await screen.findByText(t('callback.error.failed'));
      await expectNoA11yViolations(container);
    });

    it('announces the failure through the one announcer', async () => {
      signinCallback.mockRejectedValue(
        new ErrorResponse({ error: 'server_error' }),
      );

      renderAppAtUrl(RETURNED);

      await screen.findByText(t('callback.error.failed'));
      // `ErrorState` routes its announcement through the announcer rather than
      // mounting a `role="alert"` of its own (ADR-027 allows exactly one live
      // region, and it is the announcer's).
      await waitFor(() => {
        expect(document.querySelectorAll('[data-live-announcer]')).toHaveLength(
          1,
        );
      });
      expect(document.querySelector('[role="alert"]')).toBeNull();
    });
  });
});
