import { useCompanyRolesList } from '../../../../api/hooks';
import { t } from '../../../../strings';

export interface RoleDetailsProps {
  readonly companyId: string;
  readonly roleId: string;
  readonly headingId: string;
}

/** One role's live details in the office tray: its name and description. */
export const RoleDetails = ({
  companyId,
  roleId,
  headingId,
}: RoleDetailsProps) => {
  const rolesQuery = useCompanyRolesList(companyId);

  if (rolesQuery.isPending) {
    return (
      <>
        <h2 id={headingId}>{t('visualisation.tray.heading')}</h2>
        <p>{t('visualisation.tray.loading')}</p>
      </>
    );
  }

  const role = rolesQuery.data?.find((candidate) => candidate.id === roleId);
  if (role === undefined) {
    return (
      <>
        <h2 id={headingId}>{t('visualisation.tray.heading')}</h2>
        <p>{t('visualisation.tray.gone')}</p>
      </>
    );
  }

  return (
    <>
      <h2 id={headingId}>
        {t('visualisation.tray.roleHeading', { name: role.name })}
      </h2>
      <p>{role.description}</p>
    </>
  );
};
