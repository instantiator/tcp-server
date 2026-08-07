import { useEffect, useRef, useState } from 'react';
import { Button } from 'react-aria-components';
import { ANNOUNCE_IMMEDIATE_MS, announce } from '../announce/announcer';
import { getUserManager } from '../auth/user-manager';
import { handleUnauthorized } from '../auth/unauthorized';
import { useSession } from '../auth/useSession';
import { t } from '../strings';
import './SessionExpiryWarning.css';

/**
 * The 30-second warning before the access token expires, with the control
 * that extends the session.
 *
 * **The "Stay signed in" button is what makes this timed session meet WCAG
 * 2.2.1 "Timing Adjustable"; it is not decoration.** It calls
 * {@link handleUnauthorized}, the same one redirect `RequireSession` uses to
 * recover a reload — against a live provider session that comes back in a few
 * hundred milliseconds and returns the user to the page they were on. Without
 * it, expiry would remove the user with no way for the user to prevent that.
 *
 * **Nothing here self-dismisses on a timer** (ADR-026 adopts WCAG 2.2.3). It
 * renders while `getUserManager().events` says the token is expiring, and
 * stops when the session is renewed (`userLoaded`) or removed
 * (`userUnloaded`) — never because time passed while it was on screen.
 *
 * **Deliberately not `role="alert"`, and this mounts no live region of its
 * own.** ADR-027 allows exactly one announcer in the application; several
 * regions updating together produce interleaved, unreadable output, which is
 * exactly what a second one here would risk. `ErrorState`'s doc comment is the
 * fuller explanation and the register this follows. The visible half still
 * renders in place, and the announced half is routed through the one
 * announcer instead.
 */
export const SessionExpiryWarning = () => {
  const session = useSession();
  const [expiring, setExpiring] = useState(false);

  useEffect(() => {
    const { events } = getUserManager();

    // Each `add*` returns its own unsubscriber in oidc-client-ts v3 — collected
    // here and called in the cleanup, rather than pairing `remove*` calls by
    // hand.
    const unsubscribers = [
      events.addAccessTokenExpiring(() => {
        setExpiring(true);
      }),
      events.addUserLoaded(() => {
        setExpiring(false);
      }),
      events.addUserUnloaded(() => {
        setExpiring(false);
      }),
    ];

    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, []);

  // Keyed on the expiring flag, not on whether this effect has run:
  // `StrictMode` invokes it twice on mount, and a boolean "have I run?" guard
  // would be spent by the first invocation and never announce the second time
  // the token starts expiring in the same session.
  const announced = useRef(false);

  useEffect(() => {
    if (!expiring) {
      announced.current = false;
      return;
    }
    if (announced.current) return;
    announced.current = true;

    announce({
      channel: 'auth',
      change: 'session.expiring.announcement',
      politeness: 'assertive',
      throttleMs: ANNOUNCE_IMMEDIATE_MS,
    });
  }, [expiring]);

  if (session === null || !expiring) return null;

  return (
    <div
      className="session-expiry"
      role="group"
      aria-label={t('session.expiry.label')}
    >
      <p className="session-expiry__message">{t('session.expiring')}</p>
      <Button
        className="react-aria-Button session-expiry__stay"
        onPress={() => void handleUnauthorized()}
      >
        {t('session.staySignedIn')}
      </Button>
    </div>
  );
};
