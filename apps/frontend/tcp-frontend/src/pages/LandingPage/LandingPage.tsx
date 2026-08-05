import { Button } from 'react-aria-components';
import { startSignIn } from '../../auth/sign-in';
import { t } from '../../strings';
import { ThemeControl } from '../../theme/ThemeControl';
import './LandingPage.css';

/**
 * The first thing a signed-out visitor sees, and where signing out returns
 * them (ADR-020).
 *
 * The heading outline here is the pattern the rest of the application follows:
 * one `h1` naming the application, then an `h2` per section, with no level
 * skipped. `main` lives in this component until 003.02's shell owns the
 * layout; there must never be two.
 */
export const LandingPage = () => (
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
