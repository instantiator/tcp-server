import { Outlet } from 'react-router';
import { t } from '../strings';
import { Header } from './Header';
import './AppShell.css';

/**
 * The frame every signed-in page renders inside, and the not-found page with
 * it — an unknown address is reached without a session, and is the only route
 * in the shell that can be.
 *
 * Order matters and is the whole point of this component: the skip link is the
 * first thing in the tab order, the header comes next, and `main` follows both,
 * so that bypassing the header actually skips something. `main` carries
 * `tabIndex={-1}` because several browsers move the caret to a fragment target
 * without moving focus to it unless it is focusable.
 *
 * The landing page renders outside this shell and owns its own `main` — there
 * must never be two on one page.
 */
export const AppShell = () => (
  <div className="app-shell">
    <a className="skip-link" href="#main-content">
      {t('shell.skipToContent')}
    </a>
    <Header />
    <main className="app-shell__main" id="main-content" tabIndex={-1}>
      <Outlet />
    </main>
  </div>
);
