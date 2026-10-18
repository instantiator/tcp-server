import { Dialog } from '../Dialog/Dialog';
import { StorageBrowser } from './StorageBrowser';

export interface StorageBrowserDialogProps {
  readonly companyId: string;
  /** The folder to browse, relative to the company folder, ending in `/`. */
  readonly root: string;
  /** The dialog's title; it also names the tree. Already resolved through `t`. */
  readonly heading: string;
  readonly onClose: () => void;
  /** Keeps the dialog inside the office view in full screen. */
  readonly portalContainer?: Element | undefined;
}

/**
 * The storage browser in a dialog, for hosts with no room for it inline (the
 * office tray). Its opener mounts it only while open, so unmounting closes it
 * and focus returns to the opener's button.
 */
export const StorageBrowserDialog = ({
  companyId,
  root,
  heading,
  onClose,
  portalContainer,
}: StorageBrowserDialogProps) => (
  <Dialog heading={heading} onClose={onClose} portalContainer={portalContainer}>
    <StorageBrowser
      companyId={companyId}
      root={root}
      label={heading}
      portalContainer={portalContainer}
    />
  </Dialog>
);
