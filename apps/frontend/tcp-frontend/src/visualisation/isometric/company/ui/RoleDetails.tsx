import { MessageCircle } from 'lucide-react';
import { useId } from 'react';
import { useCompanyRolesList } from '../../../../api/hooks';
import { useStartChatAction } from '../../../../components/AddNew/useStartChatAction';
import { RoundIconButton } from '../../../../components/RoundIconButton/RoundIconButton';
import { ExpandableText } from '../../../../components/ExpandableText/ExpandableText';
import { t } from '../../../../strings';
import { TrayPanel } from './TrayPanel';

export interface RoleDetailsProps {
  readonly companyId: string;
  readonly roleId: string;
  readonly headingId: string;
  /** Where tooltips are portalled; see `VisualisationTrayProps.portalContainer`. */
  readonly portalContainer?: Element | undefined;
}

/**
 * One role's live details in the office tray: its name, its description, and
 * a way to start a chat with it (003.01 stage 4).
 *
 * `useStartChatAction` (built for `AddNewMenu`'s roles submenu) does the
 * work here too: it tracks the in-flight attempt and announces a failure on
 * its own channel, so this only has to show what it reports — `isPending` on
 * the icon button (React Aria keeps it focusable and announces progress
 * itself, so the label does not need to change) and an error paragraph the button
 * points to with `aria-describedby`.
 */
export const RoleDetails = ({
  companyId,
  roleId,
  headingId,
  portalContainer,
}: RoleDetailsProps) => {
  const rolesQuery = useCompanyRolesList(companyId);
  const errorId = useId();
  const { start, pendingRoleId, error } = useStartChatAction(companyId);

  if (rolesQuery.isPending) {
    return (
      <TrayPanel
        headingId={headingId}
        heading={t('visualisation.tray.heading')}
      >
        <p>{t('visualisation.tray.loading')}</p>
      </TrayPanel>
    );
  }

  const role = rolesQuery.data?.find((candidate) => candidate.id === roleId);
  if (role === undefined) {
    return (
      <TrayPanel
        headingId={headingId}
        heading={t('visualisation.tray.heading')}
      >
        <p>{t('visualisation.tray.gone')}</p>
      </TrayPanel>
    );
  }

  return (
    <TrayPanel
      headingId={headingId}
      heading={t('visualisation.tray.roleHeading', { name: role.name })}
      actions={
        <RoundIconButton
          icon={MessageCircle}
          label={t('visualisation.tray.chatWithRole', { role: role.name })}
          portalContainer={portalContainer}
          isPending={pendingRoleId === role.id}
          aria-describedby={error !== null ? errorId : undefined}
          onPress={() => {
            start({ id: role.id, name: role.name });
          }}
        />
      }
      description={
        <ExpandableText
          text={role.description}
          variant="icon"
          expandLabel={t('visualisation.tray.description.expand')}
          collapseLabel={t('visualisation.tray.description.collapse')}
          portalContainer={portalContainer}
        />
      }
    >
      {error !== null && (
        <p id={errorId}>{t('addNew.error', { role: role.name })}</p>
      )}
    </TrayPanel>
  );
};
