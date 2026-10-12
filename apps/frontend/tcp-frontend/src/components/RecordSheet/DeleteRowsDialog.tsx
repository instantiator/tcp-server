import { Button } from 'react-aria-components';
import { t, tCount } from '../../strings';
import { ButtonRow } from '../ButtonRow/ButtonRow';
import { Dialog } from '../Dialog/Dialog';

export interface DeleteRowsDialogProps {
  /** How many rows will go. */
  readonly count: number;
  readonly isPending: boolean;
  readonly onConfirm: () => void;
  /** Downloads the rows first; the dialog stays open. */
  readonly onDownload: () => void;
  readonly onCancel: () => void;
  readonly portalContainer?: Element | undefined;
}

/**
 * Asks before deleting chosen rows, and offers a copy of them first, as
 * clearing a table does. Focus starts on "No".
 */
export const DeleteRowsDialog = ({
  count,
  isPending,
  onConfirm,
  onDownload,
  onCancel,
  portalContainer,
}: DeleteRowsDialogProps) => (
  <Dialog
    confirmation
    heading={tCount('records.deleteRows.heading', count)}
    portalContainer={portalContainer}
    onClose={onCancel}
  >
    <p>{t('records.deleteRows.message')}</p>
    <ButtonRow>
      <Button
        className="react-aria-Button"
        isPending={isPending}
        onPress={onConfirm}
      >
        {t('records.deleteRows.confirm')}
      </Button>
      <Button
        className="react-aria-Button tcp-button--outline"
        onPress={onDownload}
      >
        {t('records.downloadFirst')}
      </Button>
      <Button
        className="react-aria-Button tcp-button--outline"
        // Inside a modal that just opened, not on page load, which is what the
        // rule guards against: focus lands on the safe answer.
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        onPress={onCancel}
      >
        {t('confirm.no')}
      </Button>
    </ButtonRow>
  </Dialog>
);
