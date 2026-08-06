import { useEffect, useRef } from 'react';
import { Button } from 'react-aria-components';
import { Link } from 'react-router';
import {
  ANNOUNCE_IMMEDIATE_MS,
  announce,
  type Politeness,
} from '../../announce/announcer';
import { t } from '../../strings';
import './Notification.css';

export interface NotificationProps {
  /** What happened. Already resolved through `t`. */
  readonly message: string;
  /**
   * Where the same information also lives, permanently.
   *
   * Required, and that is the point. ADR-026 adopts WCAG 2.2.3 "No Timing":
   * a notification is never the only record of an event. Making the durable
   * destination a required prop means a notification cannot be rendered
   * without naming one — the criterion is enforced by the compiler rather
   * than by a reviewer remembering it.
   */
  readonly durableHref: string;
  /** What that destination is called, for the link's accessible name. */
  readonly durableLabel: string;
  /** Removes it. There is no timer in this file: nothing here self-dismisses. */
  readonly onDismiss: () => void;
  /** The announcer channel of the surface the event belongs to. */
  readonly channel: string;
  /** `assertive` on failure, per ADR-027's toast row. Defaults to `polite`. */
  readonly politeness?: Politeness;
}

/**
 * Tells a user about something that happened where they weren't looking — a
 * task failing while its dialog is closed.
 *
 * **Nothing here dismisses itself.** A notice that vanishes on a timer is
 * unreadable to anyone who reads slowly, is away from the screen, or is
 * hearing the page rather than seeing it, which is why ADR-026 adopts WCAG
 * 2.2.3. It leaves when the user says so.
 *
 * **Nothing plumbs it in yet, deliberately.** There is no queue, no provider
 * and no container: nothing produces background events until 005.02's event
 * stream, and where notifications sit on the page is a layout decision that
 * belongs to the first view with somewhere to put them (007.01). What could
 * not wait is the shape — the rules above are the ones that get lost when a
 * notification is reinvented per view, and a required `durableHref` is the
 * cheapest way to make them survive.
 */
export const Notification = ({
  message,
  durableHref,
  durableLabel,
  onDismiss,
  channel,
  politeness = 'polite',
}: NotificationProps) => {
  // Keyed on the message, not on whether this effect has run: `StrictMode`
  // invokes it twice on mount, and the announcer counts repeats rather than
  // discarding them, so a run-count guard would announce this twice.
  const announced = useRef<string | null>(null);

  useEffect(() => {
    if (announced.current === message) return;
    announced.current = message;

    // On appearance, not up to ten seconds later. The default throttle exists
    // for channels that accumulate — a list absorbing a burst of changes — and
    // a notification is one discrete event that has already happened. The
    // zero-length window still folds several arriving in the same tick into
    // one phrase, which is the part worth keeping.
    announce({
      channel,
      change: 'notification.announcement',
      params: { message },
      politeness,
      throttleMs: ANNOUNCE_IMMEDIATE_MS,
    });
  }, [channel, message, politeness]);

  return (
    <div
      className="notification"
      role="group"
      aria-label={t('notification.label')}
    >
      <p className="notification__message">{message}</p>
      <Link className="notification__durable" to={durableHref}>
        {durableLabel}
      </Link>
      <Button
        className="react-aria-Button notification__dismiss"
        onPress={onDismiss}
      >
        {t('notification.dismiss')}
      </Button>
    </div>
  );
};
