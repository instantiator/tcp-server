import { Button } from 'react-aria-components';
import { t } from '../../strings';
import { ButtonRow } from '../ButtonRow/ButtonRow';
import { Dialog } from './Dialog';

export interface ConfirmDialogProps {
  readonly isOpen: boolean;
  /** The question, which is also the dialog's accessible name. */
  readonly heading: string;
  /** What saying yes will do. */
  readonly message: string;
  readonly onConfirm: () => void;
  /** Called on "no" and on escape. */
  readonly onCancel: () => void;
  /** Defaults to "Yes". Name the action where a bare yes would be vague. */
  readonly confirmLabel?: string;
  /** Defaults to "No". */
  readonly cancelLabel?: string;
  readonly portalContainer?: Element | undefined;
}

/**
 * Asks a yes/no question before something that can't be undone.
 *
 * No minimise and no close, so the answer comes from the buttons (000.06).
 * Focus starts on "no": a stray Enter must not delete anything.
 */
export const ConfirmDialog = ({
  isOpen,
  heading,
  message,
  onConfirm,
  onCancel,
  confirmLabel = t('confirm.yes'),
  cancelLabel = t('confirm.no'),
  portalContainer,
}: ConfirmDialogProps) => (
  <Dialog
    confirmation
    isOpen={isOpen}
    onClose={onCancel}
    portalContainer={portalContainer}
    heading={heading}
  >
    <p>{message}</p>
    <ButtonRow>
      <Button className="react-aria-Button" onPress={onConfirm}>
        {confirmLabel}
      </Button>
      <Button
        className="react-aria-Button tcp-button--outline"
        // Inside a modal that just opened, not on page load, which is what the
        // rule guards against: focus lands on the safe answer.
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        onPress={onCancel}
      >
        {cancelLabel}
      </Button>
    </ButtonRow>
  </Dialog>
);
