import { Outlet } from 'react-router';
import { ChatProvider } from '../components/ChatDialog/ChatProvider';
import { DockProvider } from '../components/Dialog/DockProvider';
import { t } from '../strings';
import { Header } from './Header';
import { SessionExpiryWarning } from './SessionExpiryWarning';
import { SystemBanner } from './SystemBanner';
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
 * {@link SessionExpiryWarning} sits outside `main` for the same reason the
 * header does: the route replaces `main`'s content, and a warning about the
 * session belongs to the shell rather than to whichever page happens to be
 * showing when the token starts expiring.
 *
 * {@link SystemBanner} sits beside it for the same reason: a shutdown or
 * restart concerns every page, and every signed-in user.
 *
 * The landing page renders outside this shell and owns its own `main` — there
 * must never be two on one page.
 *
 * {@link DockProvider} wraps the shell rather than sitting inside `main`,
 * because a minimised dialog belongs to the session rather than to whichever
 * route is showing: navigating must not empty the dock. It renders nothing
 * until a dialog is actually minimised.
 *
 * {@link ChatProvider} sits immediately inside it, for the same reason and one
 * more: the dock holds a `restore` callback for every parked chat, and a
 * callback pointing into a page that has since unmounted is a button that does
 * nothing. Holding the conversations at the dock's own level means the two
 * cannot fall out of step. It also renders nothing until a chat is opened.
 */
export const AppShell = () => (
  <DockProvider>
    <ChatProvider>
      <div className="app-shell">
        <a className="skip-link" href="#main-content">
          {t('shell.skipToContent')}
        </a>
        <Header />
        <SessionExpiryWarning />
        <SystemBanner />
        <main className="app-shell__main" id="main-content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </ChatProvider>
  </DockProvider>
);
