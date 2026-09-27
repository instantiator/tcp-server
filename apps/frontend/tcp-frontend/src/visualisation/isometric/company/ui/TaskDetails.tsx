import {
  useCompanyRolesList,
  useLiveAssignmentsList,
  useLiveCompanyTasksList,
} from '../../../../api/hooks';
import type { AssignmentDTO } from '../../../../api/dtos';
import { statusLabel } from '../../../../api/statuses';
import { ExpandableText } from '../../../../components/ExpandableText/ExpandableText';
import { t } from '../../../../strings';
import { modeLabel } from './modeLabel';

export interface TaskDetailsProps {
  readonly companyId: string;
  readonly taskId: string;
  readonly headingId: string;
}

/** Ascending `orderIndex`, with a `null` (not yet planned into a step) last. */
const byOrderIndex = (a: AssignmentDTO, b: AssignmentDTO): number => {
  const left = a.orderIndex ?? null;
  const right = b.orderIndex ?? null;
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
};

/**
 * One task's live details in the office tray: its request, its status, and
 * the assignments working it, in plan order.
 *
 * Assignments come from the company's whole list, filtered to this task
 * client-side — the same list `useOfficeWorld` already holds for the rules,
 * rather than a second, task-scoped query for the same rows.
 */
export const TaskDetails = ({
  companyId,
  taskId,
  headingId,
}: TaskDetailsProps) => {
  const tasksQuery = useLiveCompanyTasksList(companyId);
  const { data: roles } = useCompanyRolesList(companyId);
  const { data: assignments } = useLiveAssignmentsList({ companyId });

  if (tasksQuery.isPending) {
    return (
      <>
        <h2 id={headingId}>{t('visualisation.tray.heading')}</h2>
        <p>{t('visualisation.tray.loading')}</p>
      </>
    );
  }

  const task = tasksQuery.data?.find((candidate) => candidate.id === taskId);
  if (task === undefined) {
    return (
      <>
        <h2 id={headingId}>{t('visualisation.tray.heading')}</h2>
        <p>{t('visualisation.tray.gone')}</p>
      </>
    );
  }

  const roleName = (roleId: string): string =>
    roles?.find((role) => role.id === roleId)?.name ??
    t('activity.role.unknown');

  const ordered = (assignments ?? [])
    .filter((assignment) => assignment.taskId === taskId)
    .sort(byOrderIndex);

  return (
    <>
      <h2 id={headingId}>
        {t('visualisation.tray.taskHeading', { shortcode: task.shortcode })}
      </h2>
      <ExpandableText
        text={task.request}
        variant="ellipsis"
        expandLabel={t('visualisation.tray.prompt.expand')}
        collapseLabel={t('visualisation.tray.prompt.collapse')}
      />
      <p>{statusLabel(task.status)}</p>
      <ul aria-label={t('visualisation.tray.assignments')}>
        {ordered.map((assignment) => (
          <li key={assignment.id}>
            {t('visualisation.tray.assignmentRow', {
              role: roleName(assignment.roleId),
              mode: modeLabel(assignment.mode),
              status: statusLabel(assignment.status),
            })}
          </li>
        ))}
      </ul>
    </>
  );
};
