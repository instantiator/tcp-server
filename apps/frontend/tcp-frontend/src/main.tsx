import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { SessionProvider } from './auth/session';
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
      <ThemeProvider>
        <BrowserRouter>
          {/* No session exists until 004.03, so every protected route redirects — correctly. */}
          <SessionProvider>
            <App />
          </SessionProvider>
        </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
