import { useEffect, useRef } from 'react';
import { Button } from 'react-aria-components';
import { announce } from '../../announce/announcer';
import { t } from '../../strings';
import './ErrorState.css';

export interface ErrorStateProps {
  /** What failed, in the user's terms. Already resolved through `t`. */
  readonly message: string;
  /** The announcer channel of the surface that failed. */
  readonly channel: string;
  /** Retries whatever failed. Omit when there is nothing to retry. */
  readonly onRetry?: () => void;
}

/**
 * A failure, shown next to whatever failed and announced immediately.
 *
 * **Deliberately not `role="alert"`.** That role is a live region, and ADR-027
 * allows exactly one of those in the application: several regions updating
 * together produce interleaved output, and three failing lists would mount
 * three alerts. Routing the announcement through the one announcer instead
 * also means two failures in the same tick become one interruption rather than
 * two — which `role="alert"` cannot do, because each region speaks for itself.
 *
 * The visible half is unaffected: this still renders in place, beside the
 * thing that broke, which is what ADR-027's "errors, in context" row asks for.
 * 001.02 (phase 06)'s manual pass confirms the announced half reads as well.
 */
export const ErrorState = ({ message, channel, onRetry }: ErrorStateProps) => {
  // Keyed on the message, not on whether this effect has run: `StrictMode`
  // invokes it twice on mount, and the announcer counts repeats rather than
  // discarding them, so a run-count guard would announce the failure twice.
  const announced = useRef<string | null>(null);

  useEffect(() => {
    if (announced.current === message) return;
    announced.current = message;

    announce({
      channel,
      change: 'state.error.announcement',
      params: { message },
      politeness: 'assertive',
    });
  }, [channel, message]);

  return (
    <div
      className="error-state"
      role="group"
      aria-label={t('state.error.label')}
    >
      <p className="error-state__message">{message}</p>
      {onRetry !== undefined && (
        <Button
          className="react-aria-Button error-state__retry"
          onPress={onRetry}
        >
          {t('state.error.retry')}
        </Button>
      )}
    </div>
  );
};
