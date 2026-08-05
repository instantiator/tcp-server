import { Route, Routes } from 'react-router';
import { LandingPage } from './pages/LandingPage/LandingPage';
import { channelForAgent } from './shared-client';

/**
 * The application's routes. Still only the landing page — the route table,
 * the catch-all and the shell are 003.02.
 *
 * The hidden `channelForAgent` reference keeps the `@tcp/shared/client` import
 * boundary's positive control reachable from the entry point, so the bundler
 * actually resolves it. The landing page imports nothing from the shared
 * package; 005.02's SSE client will be the first screen that does, and should
 * remove this.
 */
export const App = () => (
  <>
    <Routes>
      <Route path="/" element={<LandingPage />} />
    </Routes>
    <span hidden>{channelForAgent('boundary-control')}</span>
  </>
);
