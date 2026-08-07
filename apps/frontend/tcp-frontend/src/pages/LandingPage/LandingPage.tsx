import { useState } from 'react';
import { Button } from 'react-aria-components';
import { useLocation } from 'react-router';
import { startSignIn } from '../../auth/sign-in';
import { ErrorState } from '../../components/ErrorState/ErrorState';
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
  // `RequireSession` sends a signed-out visitor here with `{ from }` in the
  // location state. This page never reads inside it — it hands the whole thing
  // to `startSignIn`, and `safeRedirectTarget` is the only code that knows the
  // shape, and the only code that trusts it.
  // Typed here rather than destructured: React Router declares location state
  // as `any`, and this is the one value on this page that must not be trusted.
  const state: unknown = useLocation().state;
  const [failed, setFailed] = useState(false);

  return (
    <main className="landing-page">
      <h1>{t('app.title')}</h1>
      <p className="landing-page__intro">{t('landing.intro')}</p>

      <section className="landing-page__section">
        <h2>{t('landing.getStarted.heading')}</h2>
        {/*
          An arrow, not the bare function reference: React Aria passes a
          `PressEvent` as the first argument, and that would arrive as the
          destination to return to.
        */}
        <Button
          className="react-aria-Button"
          onPress={() => {
            setFailed(false);
            void startSignIn(state).catch(() => {
              setFailed(true);
            });
          }}
        >
          {t('landing.signIn')}
        </Button>
        {/*
          No `onRetry`: the sign-in control is directly above, and a second
          button doing the same thing is one more stop for a keyboard user
          between the message and the fix.
        */}
        {failed && (
          <ErrorState message={t('landing.signIn.failed')} channel="auth" />
        )}
      </section>

      <section className="landing-page__section">
        <h2>{t('landing.appearance.heading')}</h2>
        <ThemeControl />
      </section>
    </main>
  );
};
