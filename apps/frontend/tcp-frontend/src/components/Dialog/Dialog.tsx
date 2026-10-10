import { Minus } from 'lucide-react';
import { use, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  Dialog as AriaDialog,
  Heading,
  Modal,
  ModalOverlay,
} from 'react-aria-components';
import { t } from '../../strings';
import { CloseButton } from '../CloseButton/CloseButton';
import { RoundIconButton } from '../RoundIconButton/RoundIconButton';
import { DockContext } from './useDock';
import './Dialog.css';

export interface DialogProps {
  /**
   * Whether the dialog is showing. The caller owns this, not the dialog.
   * Defaults to `true`, for a dialog its opener mounts only while it is open.
   */
  readonly isOpen?: boolean;
  /** Called with `false` when the user closes the dialog or presses escape. */
  readonly onOpenChange?: (isOpen: boolean) => void;
  /** Called when the user closes the dialog or presses escape: the usual case. */
  readonly onClose?: () => void;
  /**
   * Where the dialog is portalled, when it must stay inside an element such
   * as the office view in full screen. The page body when omitted.
   */
  readonly portalContainer?: Element | undefined;
  /** The dialog's title, which is also its accessible name. Already resolved through `t`. */
  readonly heading: string;
  readonly children: ReactNode;
  /**
   * Replaces the built-in minimise, for a caller that parks itself — the chat
   * dialog keeps its own dock entry. Omit to get the built-in one.
   */
  readonly onMinimise?: () => void;
  /**
   * A yes/no question rather than a window: announced as an `alertdialog`,
   * with no minimise or close, so the user answers with the buttons (000.06).
   * Escape still dismisses it, which the caller treats as "no".
   */
  readonly confirmation?: boolean;
  /**
   * Suppresses the framework's own close button. Escape and `onOpenChange` are
   * untouched — this hides a control, it does not remove a dismissal path.
   */
  readonly hideClose?: boolean;
  /** Extra controls for the title bar, placed before minimise and close. */
  readonly actions?: ReactNode;
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
 * **Every dialog can be minimised** (000.06), unless it is a confirmation or
 * there is no dock. Minimising unmounts the modal, because a modal that stayed
 * mounted would keep its focus trap and keep the rest of the page inert, which
 * is wrong for a dialog the user has parked. This component stays mounted, and
 * so does whatever renders it, so the caller's state — a half-written task,
 * say — is still there when the dock restores it. Anything inside the modal
 * unmounts, which releases its streams.
 *
 * Clicking outside does not close it: a dialog holding a half-typed message
 * should not vanish on a stray click. Escape still does, which is what ADR-026
 * requires.
 *
 * **`hideClose` is for a dialog whose Close would be a duplicate of its
 * Minimise.** A caller that parks rather than closes — the chat dialog — wires
 * `onOpenChange(false)` to the same thing `onMinimise` does, so both buttons
 * do exactly one thing under two names. That is a real bug, not a hypothetical:
 * two controls that look like different outcomes and are not. Hiding the close
 * button leaves one visible control saying what it does, with escape still
 * dismissing the dialog as ADR-026 requires.
 */
export const Dialog = ({
  isOpen = true,
  onOpenChange,
  onClose,
  portalContainer,
  heading,
  children,
  onMinimise,
  hideClose = false,
  actions,
  confirmation = false,
}: DialogProps) => {
  const dock = use(DockContext);
  const dockId = useId();
  const [minimised, setMinimised] = useState(false);

  // A dialog its owner closes while parked must not leave its button behind.
  // Through a ref: `remove` changes identity with every dock change, and an
  // effect keyed on it would remove the entry the moment it was added.
  const dockRef = useRef(dock);
  dockRef.current = dock;
  useEffect(
    () => () => {
      dockRef.current?.remove(dockId);
    },
    [dockId],
  );

  const changeOpen = (open: boolean): void => {
    onOpenChange?.(open);
    if (!open) onClose?.();
  };

  const minimise =
    onMinimise ??
    (dock === null || confirmation
      ? undefined
      : () => {
          dock.minimise({
            id: dockId,
            label: heading,
            restore: () => {
              setMinimised(false);
            },
          });
          setMinimised(true);
          // Focus has to land somewhere deliberate once the modal is gone
          // (ADR-027): the button that now stands for it.
          dock.focusEntry(dockId);
        });

  return (
    <ModalOverlay
      isOpen={isOpen && !minimised}
      onOpenChange={changeOpen}
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- deliberate; see `WithTooltip`
      UNSTABLE_portalContainer={portalContainer}
    >
      <Modal>
        <AriaDialog role={confirmation ? 'alertdialog' : 'dialog'}>
          <div className="dialog__bar">
            <Heading
              slot="title"
              className="react-aria-Heading dialog__heading"
            >
              {heading}
            </Heading>
            {actions}
            {minimise !== undefined && (
              <RoundIconButton
                icon={Minus}
                className="dialog__minimise"
                label={t('dialog.minimise')}
                portalContainer={portalContainer}
                onPress={minimise}
              />
            )}
            {!hideClose && !confirmation && (
              <CloseButton
                className="dialog__close"
                label={t('dialog.close')}
                portalContainer={portalContainer}
                onPress={() => {
                  changeOpen(false);
                }}
              />
            )}
          </div>
          <div className="dialog__body">{children}</div>
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
};
