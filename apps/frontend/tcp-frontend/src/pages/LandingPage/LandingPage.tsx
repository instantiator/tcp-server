import { Button } from 'react-aria-components';
import { startSignIn } from '../../auth/sign-in';
import { useDocumentTitle } from '../../shell/useDocumentTitle';
import { t } from '../../strings';
import { ThemeControl } from '../../theme/ThemeControl';
import './LandingPage.css';

/**
 * The first thing a signed-out visitor sees, and where signing out returns
 * them (ADR-020).
 *
 * The heading outline here is the pattern the rest of the application follows:
 * one `h1` naming the application, then an `h2` per section, with no level
 * skipped.
 *
 * The landing page renders outside the application shell — it is header-free —
 * so it owns its own `main`. Every other page's `main` comes from `AppShell`;
 * there must never be two.
 *
 * It sets its own title like every other page, even though `index.html`
 * already says "TCP": the title is what a route change announces, so a page
 * that leaves it alone announces the name of the page before it.
 */
export const LandingPage = () => {
  useDocumentTitle(t('app.title'));

  return (
    <main className="landing-page">
      <h1>{t('app.title')}</h1>
      <p className="landing-page__intro">{t('landing.intro')}</p>

      <section className="landing-page__section">
        <h2>{t('landing.getStarted.heading')}</h2>
        <Button className="react-aria-Button" onPress={startSignIn}>
          {t('landing.signIn')}
        </Button>
      </section>

      <section className="landing-page__section">
        <h2>{t('landing.appearance.heading')}</h2>
        <ThemeControl />
      </section>
    </main>
  );
};
