import { ProgressBar } from 'react-aria-components';
import { t } from '../../strings';
import './LoadingState.css';

/**
 * A wait in progress, for any view or dialog that is fetching something.
 *
 * **It announces nothing.** ADR-027 announces the *completion* of a wait, and
 * only when the wait was long enough to be worth mentioning — see
 * {@link useLoadingAnnouncement}, which the surface owning the data calls.
 * Announcing the start would interrupt the user to tell them what they just
 * asked for.
 *
 * **It does not set `aria-busy` either.** ADR-027 marks the *region* whose
 * content is loading as busy, and that region belongs to the caller: this
 * component does not know how much of the page it stands in for.
 *
 * `role="progressbar"` with no value is the indeterminate case, and is
 * deliberately not a live region — a spinner that announced itself on mount
 * would be the scattered-live-region failure in miniature.
 */
export const LoadingState = ({ label }: { readonly label: string }) => {
  const message = t('state.loading', { label });

  return (
    <ProgressBar
      isIndeterminate
      aria-label={message}
      className="react-aria-ProgressBar loading-state"
    >
      <span className="loading-state__message">{message}</span>
    </ProgressBar>
  );
};
