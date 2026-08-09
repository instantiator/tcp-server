import type { ReactNode } from 'react';
import {
  Button,
  Dialog as AriaDialog,
  Heading,
  Modal,
  ModalOverlay,
} from 'react-aria-components';
import { t } from '../../strings';
import './Dialog.css';

export interface DialogProps {
  /** Whether the dialog is showing. The caller owns this, not the dialog. */
  readonly isOpen: boolean;
  /** Called with `false` when the user closes the dialog or presses escape. */
  readonly onOpenChange: (isOpen: boolean) => void;
  /** The dialog's title, which is also its accessible name. Already resolved through `t`. */
  readonly heading: string;
  readonly children: ReactNode;
  /**
   * Parks the dialog in the dock instead of closing it. Omit for a dialog that
   * cannot be minimised, which is all of them but the chat dialog (008.02).
   */
  readonly onMinimise?: () => void;
}

/**
 * A modal dialog: focus moves in on open, is trapped while open, and returns
 * to whatever opened it on close. Escape closes it. Its heading is its
 * accessible name.
 *
 * All of that comes from React Aria's `ModalOverlay`/`Modal`/`Dialog`, taken
 * whole rather than hand-rolled — ADR-026 chose the library for these dialogs
 * specifically, because focus trapping, scroll locking and stacked-dialog
 * semantics are where hand-written implementations fail. `<Heading slot="title">`
 * is what wires the accessible name; a plain `h2` would leave the dialog
 * unnamed.
 *
 * **Minimising unmounts the dialog.** A modal that stayed mounted would keep
 * its focus trap and keep the rest of the page inert, which is wrong for a
 * dialog the user has parked. The caller keeps whatever state the dialog needs
 * and re-opens it when the dock restores it — see `dock.tsx`.
 *
 * Clicking outside does not close it: a dialog holding a half-typed message
 * should not vanish on a stray click. Escape still does, which is what ADR-026
 * requires.
 */
export const Dialog = ({
  isOpen,
  onOpenChange,
  heading,
  children,
  onMinimise,
}: DialogProps) => (
  <ModalOverlay isOpen={isOpen} onOpenChange={onOpenChange}>
    <Modal>
      <AriaDialog>
        <div className="dialog__bar">
          <Heading slot="title" className="react-aria-Heading dialog__heading">
            {heading}
          </Heading>
          {onMinimise !== undefined && (
            <Button
              className="react-aria-Button dialog__minimise"
              onPress={onMinimise}
            >
              {t('dialog.minimise')}
            </Button>
          )}
          <Button
            className="react-aria-Button dialog__close"
            onPress={() => {
              onOpenChange(false);
            }}
          >
            {t('dialog.close')}
          </Button>
        </div>
        <div className="dialog__body">{children}</div>
      </AriaDialog>
    </Modal>
  </ModalOverlay>
);
