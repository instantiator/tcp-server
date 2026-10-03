import { useListChangeAnnouncement } from '../../../announce/useListChangeAnnouncement';
import { useLiveCompanyConsultationsList } from '../../../api/hooks';
import { ACTIVE_ASSIGNMENT_STATUSES, statusLabel } from '../../../api/statuses';
import { t } from '../../../strings';
import { ActivityList } from './ActivityList';
import { roleLabel, type ListProps } from './activity-list-utils';

/**
 * Open consultations — assignments in `consultee` mode with no task, per
 * ADR-023. Rows are non-interactive: no assignment dialog exists in the MVP.
 */
export const ConsultationsList = ({
  companyId,
  roleNames,
  onCount,
}: ListProps) => {
  const query = useLiveCompanyConsultationsList(companyId);
  const rows = query.data?.filter((assignment) =>
    ACTIVE_ASSIGNMENT_STATUSES.some((active) => active === assignment.status),
  );

  useListChangeAnnouncement(
    rows?.map((assignment) => assignment.id),
    {
      channel: 'consultations',
      added: 'announce.consultationsOpened',
      removed: 'announce.consultationsClosed',
    },
  );

  return (
    <ActivityList
      onCount={onCount}
      heading={t('activity.consultations.heading')}
      query={query}
      channel="consultations"
      count={rows?.length ?? 0}
      emptyHeading={t('activity.consultations.empty.heading')}
      emptyBody={t('activity.consultations.empty.body')}
      // ADR-023: this list is consultee assignments that have been picked up,
      // so it is an approximation and must not present itself as complete.
      note={t('activity.consultations.partial')}
    >
      <ul className="activity-list__rows">
        {rows?.map((assignment) => (
          // Non-interactive: no assignment dialog exists in the MVP.
          <li className="activity-list__row" key={assignment.id}>
            <p className="activity-list__row-title">
              {roleLabel(roleNames, assignment.roleId)}
            </p>
            <p className="activity-list__row-detail">
              {statusLabel(assignment.status)}
            </p>
          </li>
        ))}
      </ul>
    </ActivityList>
  );
};
