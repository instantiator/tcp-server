import { Dialog } from '../../../components/Dialog/Dialog';
import { t } from '../../../strings';

export interface RoleDialogProps {
  readonly companyId: string;
  /** The role to show, or `null` to add a new one. */
  readonly roleId: string | null;
  readonly onClose: () => void;
}

/**
 * One role's details, or a new role's (002.00). A placeholder until the
 * details form and the knowledge tab are built (stages 6 and 7).
 */
export const RoleDialog = ({ onClose }: RoleDialogProps) => (
  <Dialog onClose={onClose} heading={t('admin.roles.heading')}>
    <p>{t('admin.placeholder')}</p>
  </Dialog>
);
