import { useId, type ReactNode } from 'react';
import { Button } from 'react-aria-components';
import { useCompanyRolesList } from '../../../../api/hooks';
import { useStartChatAction } from '../../../../components/AddNew/useStartChatAction';
import { t } from '../../../../strings';
import { TrayHeading } from './TrayHeading';

export interface RoleDetailsProps {
  readonly companyId: string;
  readonly roleId: string;
  readonly headingId: string;
  /** The follow toggle, shown beside this panel's own heading. */
  readonly headingAction?: ReactNode;
}

/**
 * One role's live details in the office tray: its name, its description, and
 * a way to start a chat with it (003.01 stage 4).
 *
 * `useStartChatAction` (built for `AddNewMenu`'s roles submenu) does the
 * work here too: it tracks the in-flight attempt and announces a failure on
 * its own channel, so this only has to show what it reports — `isPending` on
 * the button (React Aria keeps it focusable and announces progress itself,
 * so the label does not need to change) and an error paragraph the button
 * points to with `aria-describedby`.
 */
export const RoleDetails = ({
  companyId,
  roleId,
  headingId,
  headingAction,
}: RoleDetailsProps) => {
  const rolesQuery = useCompanyRolesList(companyId);
  const errorId = useId();
  const { start, pendingRoleId, error } = useStartChatAction(companyId);

  if (rolesQuery.isPending) {
    return (
      <>
        <TrayHeading id={headingId} action={headingAction}>
          {t('visualisation.tray.heading')}
        </TrayHeading>
        <p>{t('visualisation.tray.loading')}</p>
      </>
    );
  }

  const role = rolesQuery.data?.find((candidate) => candidate.id === roleId);
  if (role === undefined) {
    return (
      <>
        <TrayHeading id={headingId} action={headingAction}>
          {t('visualisation.tray.heading')}
        </TrayHeading>
        <p>{t('visualisation.tray.gone')}</p>
      </>
    );
  }

  return (
    <>
      <TrayHeading id={headingId} action={headingAction}>
        {t('visualisation.tray.roleHeading', { name: role.name })}
      </TrayHeading>
      <p>{role.description}</p>
      <Button
        className="react-aria-Button"
        isPending={pendingRoleId === role.id}
        aria-describedby={error !== null ? errorId : undefined}
        onPress={() => {
          start({ id: role.id, name: role.name });
        }}
      >
        {t('visualisation.tray.chatWithRole', { role: role.name })}
      </Button>
      {error !== null && (
        <p id={errorId}>{t('addNew.error', { role: role.name })}</p>
      )}
    </>
  );
};
