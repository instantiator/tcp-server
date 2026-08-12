import { vi } from 'vitest';

vi.mock('../auth/sign-out', () => ({ startSignOut: vi.fn() }));

// The account menu's other two destinations (008.06): `ProfileDialog` reads
// `useAuth()` directly, so a minimal stub profile is enough for this file —
// the claims themselves are `ProfileDialog.test.tsx`'s subject, not this
// file's. `MembershipsDialog` reads `useCompanies`, which needs a real fetch
// stub instead; see `installFetchMock` below.
vi.mock('react-oidc-context', () => ({
  useAuth: () => ({
    user: {
      profile: {
        sub: 'test-user',
        name: 'Test User',
        email: 'test-user@example.com',
      },
    },
  }),
}));

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionProvider } from '../auth/session';
import { startSignOut } from '../auth/sign-out';
import { t } from '../strings';
import { expectNoA11yViolations } from '../test-support/axe';
import { installFetchMock, respondWithJson } from '../test-support/fetch-mock';
import { Header } from './Header';

const SIGNED_IN = { userId: 'test-user' };

/** Renders the header with the given session, or signed out when omitted. */
const renderHeader = (session: { userId: string } | null = null) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <SessionProvider session={session}>
          <Header />
        </SessionProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('Header', () => {
  beforeEach(() => {
    vi.mocked(startSignOut).mockClear();
    installFetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows no account menu when signed out', () => {
    renderHeader();

    expect(
      screen.queryByRole('button', { name: t('header.account.label') }),
    ).toBeNull();
  });

  it('offers the three account destinations, by role and accessible name', async () => {
    const user = userEvent.setup();
    renderHeader(SIGNED_IN);

    await user.click(
      screen.getByRole('button', { name: t('header.account.label') }),
    );

    expect(
      screen.getByRole('menuitem', { name: t('header.account.profile') }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: t('header.account.memberships') }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: t('header.account.signOut') }),
    ).toBeInTheDocument();
  });

  it('opens, moves and chooses by keyboard alone', async () => {
    const user = userEvent.setup();
    renderHeader(SIGNED_IN);

    // The account button is the first (and only) focusable element on the
    // signed-in header.
    await user.tab();
    expect(
      screen.getByRole('button', { name: t('header.account.label') }),
    ).toHaveFocus();

    await user.keyboard('{Enter}');

    // React Aria focuses the first item on open, so reaching sign-out — the
    // third item — takes two more presses.
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');

    expect(startSignOut).toHaveBeenCalledTimes(1);
  });

  it('returns focus to the account button when the menu closes', async () => {
    const user = userEvent.setup();
    renderHeader(SIGNED_IN);

    const accountButton = screen.getByRole('button', {
      name: t('header.account.label'),
    });
    await user.tab();
    await user.keyboard('{Enter}');
    await user.keyboard('{Escape}');

    // React Aria restores focus on the animation frame after the overlay
    // unmounts, which does not settle within userEvent's own await.
    await waitFor(() => {
      expect(document.activeElement).toBe(accountButton);
    });
  });

  it('has no accessibility violations, with the menu open', async () => {
    const user = userEvent.setup();
    renderHeader(SIGNED_IN);

    await user.click(
      screen.getByRole('button', { name: t('header.account.label') }),
    );

    // document.body, not container: React Aria's Popover portals the menu out
    // of the render container, so scanning container with the menu open would
    // examine a tree with no menu in it and pass vacuously.
    await expectNoA11yViolations(document.body);
  });

  describe('the two dialogs (008.06)', () => {
    const openMenu = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(
        screen.getByRole('button', { name: t('header.account.label') }),
      );
    };

    it('opens the profile dialog from "My profile"', async () => {
      const user = userEvent.setup();
      renderHeader(SIGNED_IN);

      await openMenu(user);
      await user.click(
        screen.getByRole('menuitem', { name: t('header.account.profile') }),
      );

      expect(
        screen.getByRole('dialog', { name: t('profile.heading') }),
      ).toBeInTheDocument();
    });

    it('opens the memberships dialog from "My company memberships"', async () => {
      respondWithJson(200, []);
      const user = userEvent.setup();
      renderHeader(SIGNED_IN);

      await openMenu(user);
      await user.click(
        screen.getByRole('menuitem', {
          name: t('header.account.memberships'),
        }),
      );

      expect(
        screen.getByRole('dialog', { name: t('memberships.heading') }),
      ).toBeInTheDocument();
    });

    it('returns focus to the account button when the profile dialog closes', async () => {
      const user = userEvent.setup();
      renderHeader(SIGNED_IN);

      const accountButton = screen.getByRole('button', {
        name: t('header.account.label'),
      });
      await openMenu(user);
      await user.click(
        screen.getByRole('menuitem', { name: t('header.account.profile') }),
      );
      await user.click(screen.getByRole('button', { name: t('dialog.close') }));

      await waitFor(() => {
        expect(document.activeElement).toBe(accountButton);
      });
    });

    it('returns focus to the account button when the memberships dialog closes', async () => {
      respondWithJson(200, []);
      const user = userEvent.setup();
      renderHeader(SIGNED_IN);

      const accountButton = screen.getByRole('button', {
        name: t('header.account.label'),
      });
      await openMenu(user);
      await user.click(
        screen.getByRole('menuitem', {
          name: t('header.account.memberships'),
        }),
      );
      await screen.findByRole('dialog', { name: t('memberships.heading') });
      await user.click(screen.getByRole('button', { name: t('dialog.close') }));

      await waitFor(() => {
        expect(document.activeElement).toBe(accountButton);
      });
    });
  });
});
