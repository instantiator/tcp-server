import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  ANNOUNCE_IMMEDIATE_MS,
  announce,
  type Politeness,
} from '../../announce/announcer';
import { t } from '../../strings';
import { CloseButton } from '../CloseButton/CloseButton';
import { AUTO_HIDE_MS } from './auto-hide';
import './Notification.css';

export interface NotificationProps {
  /** What happened. Already resolved through `t`. It is also the link's text. */
  readonly message: string;
  /**
   * Where the same information also lives, permanently: the item's own row.
   *
   * Required, and that is the point. ADR-026 adopts WCAG 2.2.3 "No Timing":
   * content may go away on a timer only if it is duplicated somewhere durable.
   * Making the durable destination a required prop means a notification cannot
   * be rendered, and so cannot hide itself, without naming one — the criterion
   * is enforced by the compiler rather than by a reviewer remembering it.
   */
  readonly durableHref: string;
  /** Removes it. Called by Dismiss, and by the timer after {@link AUTO_HIDE_MS}. */
  readonly onDismiss: () => void;
  /** The announcer channel of the surface the event belongs to. */
  readonly channel: string;
  /** `assertive` on failure, per ADR-027's toast row. Defaults to `polite`. */
  readonly politeness?: Politeness;
}

/**
 * Tells a user about something that happened where they weren't looking — a
 * task failing while its dialog is closed. The message is itself the link to
 * the item's durable row.
 *
 * **A toast may hide itself only because `durableHref` is required**, so the
 * same information always lives in a durable row it links to (ADR-026 2.2.3:
 * "persist until dismissed, or are duplicated somewhere durable"). The timer
 * pauses while the pointer is over the toast or focus is inside it, and
 * restarts in full when both have left, so nobody loses a toast they are
 * reading or about to press.
 *
 * Where notifications sit on the page is a layout decision that belongs to
 * the view that renders them; the rules above are the ones that get lost when
 * a notification is reinvented per view.
 */
export const Notification = ({
  message,
  durableHref,
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

  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;

  // Callers pass a fresh closure every render; reading it through a ref keeps
  // a re-render from restarting the countdown.
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  // Each time `paused` goes false a new full countdown starts; going true
  // clears it.
  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(() => {
      dismissRef.current();
    }, AUTO_HIDE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [paused]);

  return (
    // The handlers only pause the countdown; the div itself does nothing when
    // pointed at or focused, so it is not an interactive element.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      className="notification"
      role="group"
      aria-label={t('notification.label')}
      onPointerEnter={() => {
        setHovered(true);
      }}
      onPointerLeave={() => {
        setHovered(false);
      }}
      onFocus={() => {
        setFocused(true);
      }}
      onBlur={(event) => {
        // Focus moving between this toast's own controls is not leaving it.
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocused(false);
        }
      }}
    >
      <Link className="notification__message" to={durableHref}>
        {message}
      </Link>
      <CloseButton
        className="notification__dismiss"
        label={t('notification.dismiss')}
        onPress={onDismiss}
      />
    </div>
  );
};
