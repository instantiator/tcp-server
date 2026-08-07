import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from 'react-oidc-context';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { AuthSession } from './auth/AuthSession';
import { getUserManager } from './auth/user-manager';
import { readDevSession } from './dev/dev-session';
import { ThemeProvider } from './theme/ThemeProvider';
import './styles/base.css';
import './styles/themes/default.css';
import './styles/themes/high-contrast.css';

// TanStack Query is the only cache in this application; there is no separate
// client-state store (ADR-021). Nothing queries yet — this makes the provider
// available so later prompts don't have to retrofit it around a mounted tree.
const queryClient = new QueryClient();

const container = document.getElementById('root');
if (container === null) {
  throw new Error('#root is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/*
        The existing singleton, never a second set of settings: two managers
        would hold two different in-memory users, and React would show a
        signed-in header while the fetch wrapper (005.01) still presented the
        old token, with no error anywhere to say so.

        This is also the mount that makes `getRuntimeConfig()` run on load, so
        a bare `vite dev` now white-screens on its thrown message. Use
        `scripts/start-deployment.sh --dev-web` and the nginx port.
      */}
      <AuthProvider userManager={getUserManager()}>
        <ThemeProvider>
          <BrowserRouter>
            {/*
              `?devSession=<id>` supplies a stand-in session for local testing.
              It is the fallback, not an override — a real signed-in user always
              wins — and it is read once here rather than per render, so it
              survives in-app navigation that drops the query string. It is
              compiled out of a production build entirely.
            */}
            <AuthSession fallback={readDevSession(window.location.search)}>
              <App />
            </AuthSession>
          </BrowserRouter>
        </ThemeProvider>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
