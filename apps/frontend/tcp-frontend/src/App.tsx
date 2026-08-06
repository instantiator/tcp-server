import { Route, Routes } from 'react-router';
import { RequireSession } from './auth/session';
import { CompaniesPage } from './pages/CompaniesPage/CompaniesPage';
import { CompanyPage } from './pages/CompanyPage/CompanyPage';
import { LandingPage } from './pages/LandingPage/LandingPage';
import { NotFoundPage } from './pages/NotFoundPage/NotFoundPage';
import { AppShell } from './shell/AppShell';
import { useRouteChange } from './shell/useRouteChange';
import { channelForAgent } from './shared-client';

/**
 * The application's route table. Every URL here can be deep-linked, refreshed
 * and shared — nginx returns the app document for any of them (ADR-029), and
 * the catch-all below is what stops an unknown one rendering a blank page.
 *
 * Three levels, and each earns its place. `/` is outside the shell because the
 * landing page is header-free and owns its own `main`. The not-found page is
 * inside the shell but outside the guard, so an unknown address stays reachable
 * signed out. Everything else sits behind `RequireSession`.
 *
 * The live region is rendered here, above `Routes`, so it is not unmounted and
 * remounted on navigation — a live region that appears at the same moment as
 * its content announces nothing at all (ADR-027). 003.03's announcer replaces
 * it; it must not become a second region.
 *
 * The hidden `channelForAgent` reference keeps the `@tcp/shared/client` import
 * boundary's positive control reachable from the entry point. 005.02's SSE
 * client is the first screen that will import from the shared package for real,
 * and should remove this.
 */
export const App = () => {
  const announcement = useRouteChange();

  return (
    <>
      <p role="status" className="visually-hidden">
        {announcement}
      </p>

      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route element={<AppShell />}>
          <Route element={<RequireSession />}>
            <Route path="/companies" element={<CompaniesPage />} />
            <Route path="/company/:companyId" element={<CompanyPage />} />
          </Route>
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>

      <span hidden>{channelForAgent('boundary-control')}</span>
    </>
  );
};
