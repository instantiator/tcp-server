import { StrictMode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { App } from '../App';
import { SessionProvider } from '../auth/session';
import type { Session } from '../auth/useSession';
import { ThemeProvider } from '../theme/ThemeProvider';

/**
 * Renders the application at a given URL, optionally signed in.
 *
 * The provider stack matches `main.tsx` exactly, with `MemoryRouter` in place
 * of `BrowserRouter`. Mocking stops at the network boundary: the session is a
 * literal object, and React Router and the query cache are real.
 *
 * `StrictMode` is part of that stack and is not decoration here. It invokes
 * every effect twice on mount, which is how the real application behaves and
 * how a "have I run before?" guard gets spent before the navigation it was
 * meant to suppress. Dropping it would leave these tests asserting a
 * configuration that only exists in the test tier — which they did, and the
 * route-change behaviour was wrong in the browser while they stayed green.
 */
export const renderAppAt = (path: string, session: Session | null = null) =>
  render(
    <StrictMode>
      <QueryClientProvider client={new QueryClient()}>
        <ThemeProvider>
          <SessionProvider session={session}>
            <MemoryRouter initialEntries={[path]}>
              <App />
            </MemoryRouter>
          </SessionProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </StrictMode>,
  );

/** A signed-in session with no properties later tests need to distinguish. */
export const TEST_SESSION: Session = { userId: 'test-user' };
