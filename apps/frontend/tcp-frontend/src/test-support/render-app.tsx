import { StrictMode, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { AuthProvider } from 'react-oidc-context';
import { BrowserRouter, MemoryRouter } from 'react-router';
import { App } from '../App';
import { AuthSession } from '../auth/AuthSession';
import { getUserManager } from '../auth/user-manager';
import type { Session } from '../auth/useSession';
import { ThemeProvider } from '../theme/ThemeProvider';

/**
 * Everything `main.tsx` mounts above the router, in the same order.
 *
 * `StrictMode` is part of that stack and is not decoration here. It invokes
 * every effect twice on mount, which is how the real application behaves and
 * how a "have I run before?" guard gets spent before the navigation it was
 * meant to suppress. Dropping it would leave these tests asserting a
 * configuration that only exists in the test tier — which they did, and the
 * route-change behaviour was wrong in the browser while they stayed green.
 *
 * `AuthProvider` is here for the same reason, and brings a consequence: it
 * constructs the OIDC client on mount, so `src/test-setup.ts` has to supply the
 * runtime configuration nginx would. It contacts nothing — the jsdom tier never
 * gets as far as discovery.
 *
 * A function that returns the tree rather than a component that renders it:
 * `react-refresh/only-export-components` is an error in this workspace, and a
 * module exporting both a component and these helpers breaks fast refresh.
 */
const withProviders = (children: ReactNode) => (
  <StrictMode>
    <QueryClientProvider client={new QueryClient()}>
      <AuthProvider userManager={getUserManager()}>
        <ThemeProvider>{children}</ThemeProvider>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>
);

/**
 * Renders the application at a given URL, optionally signed in.
 *
 * Mocking stops at the network boundary: the session is a literal object, and
 * React Router and the query cache are real. It is passed as `AuthSession`'s
 * fallback, which is what the production stack does with `?devSession=` — a
 * real OIDC user would displace it, and in this tier there is never one.
 */
export const renderAppAt = (path: string, session: Session | null = null) =>
  render(
    withProviders(
      <MemoryRouter initialEntries={[path]}>
        <AuthSession fallback={session}>
          <App />
        </AuthSession>
      </MemoryRouter>,
    ),
  );

/**
 * Renders at a real browser URL rather than a memory entry.
 *
 * The callback route needs this: `AuthProvider` decides whether to exchange an
 * authorization code by reading `window.location`, which `MemoryRouter` does
 * not touch. A memory-only render would put the router on `/callback?code=…`
 * while the library saw `/`, and the test would prove nothing.
 */
export const renderAppAtUrl = (url: string) => {
  window.history.replaceState({}, '', url);

  return render(
    withProviders(
      <BrowserRouter>
        <AuthSession>
          <App />
        </AuthSession>
      </BrowserRouter>,
    ),
  );
};

/** A signed-in session with no properties later tests need to distinguish. */
export const TEST_SESSION: Session = { userId: 'test-user' };
