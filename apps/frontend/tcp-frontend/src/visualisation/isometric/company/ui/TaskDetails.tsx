import {
  useCompanyRolesList,
  useLiveAssignmentsList,
  useLiveCompanyTasksList,
} from '../../../../api/hooks';
import type { AssignmentDTO } from '../../../../api/dtos';
import { Info } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { Button, Tooltip, TooltipTrigger } from 'react-aria-components';
import { Icon } from '../../../../components/Icon/Icon';
import { statusLabel } from '../../../../api/statuses';
import { ExpandableText } from '../../../../components/ExpandableText/ExpandableText';
import { t } from '../../../../strings';
import { modeLabel } from './modeLabel';
import { TrayHeading } from './TrayHeading';

export interface TaskDetailsProps {
  readonly companyId: string;
  readonly taskId: string;
  readonly headingId: string;
  /** The follow toggle, shown beside this panel's own heading. */
  readonly headingAction?: ReactNode;
  /** Where the assignment tooltips are portalled; see `VisualisationTrayProps.portalContainer`. */
  readonly portalContainer?: Element | undefined;
}

/** Chronological: oldest first, with the id as a stable tie-break. */
const byCreation = (a: AssignmentDTO, b: AssignmentDTO): number =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

const IN_PROGRESS_STATUSES: ReadonlySet<string> = new Set([
  'ready',
  'in-progress',
  'in-qa',
]);

interface NumberedAssignment {
  readonly assignment: AssignmentDTO;
  /** Its place in the task's whole creation order; it never changes between sections. */
  readonly number: number;
}

/**
 * The "about this assignment" control: a focusable ⓘ whose tooltip names the
 * task and assignment, then gives the assignment's prompt. A button so it
 * takes keyboard focus, which opens the tooltip as hover does (WCAG 1.4.13).
 */
const AssignmentInfo = ({
  shortcode,
  number,
  prompt,
  portalContainer,
}: {
  readonly shortcode: string;
  readonly number: number;
  readonly prompt: string;
  readonly portalContainer: Element | undefined;
}) => (
  <TooltipTrigger>
    <Button
      className="react-aria-Button"
      aria-label={t('visualisation.tray.aboutAssignment', { number })}
    >
      <Icon icon={Info} />
    </Button>
    {/* Portalled into the office view so it shows in full screen; see `WithTooltip`. */}
    <Tooltip
      className="react-aria-Tooltip"
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- deliberate; see `WithTooltip`
      UNSTABLE_portalContainer={portalContainer}
    >
      <div>
        {t('visualisation.tray.assignmentInfoTitle', {
          shortcode,
          number: String(number).padStart(3, '0'),
        })}
      </div>
      <div>{prompt}</div>
    </Tooltip>
  </TooltipTrigger>
);

/**
 * One task's live details in the office tray: its request, its status, and
 * its assignments numbered in creation order, split into those in progress and those completed.
 *
 * Assignments come from the company's whole list, filtered to this task
 * client-side — the same list `useOfficeWorld` already holds for the rules,
 * rather than a second, task-scoped query for the same rows.
 */
export const TaskDetails = ({
  companyId,
  taskId,
  headingId,
  headingAction,
  portalContainer,
}: TaskDetailsProps) => {
  const tasksQuery = useLiveCompanyTasksList(companyId);
  const { data: roles } = useCompanyRolesList(companyId);
  const { data: assignments } = useLiveAssignmentsList({ companyId });

  if (tasksQuery.isPending) {
    return (
      <>
        <TrayHeading id={headingId} action={headingAction}>
          {t('visualisation.tray.heading')}
        </TrayHeading>
        <p>{t('visualisation.tray.loading')}</p>
      </>
    );
  }

  const task = tasksQuery.data?.find((candidate) => candidate.id === taskId);
  if (task === undefined) {
    return (
      <>
        <TrayHeading id={headingId} action={headingAction}>
          {t('visualisation.tray.heading')}
        </TrayHeading>
        <p>{t('visualisation.tray.gone')}</p>
      </>
    );
  }

  const roleName = (roleId: string): string =>
    roles?.find((role) => role.id === roleId)?.name ??
    t('activity.role.unknown');

  const numbered: NumberedAssignment[] = (assignments ?? [])
    .filter((assignment) => assignment.taskId === taskId)
    .sort(byCreation)
    .map((assignment, index) => ({ assignment, number: index + 1 }));
  const sections = [
    {
      heading: t('visualisation.tray.inProgress'),
      rows: numbered.filter(({ assignment }) =>
        IN_PROGRESS_STATUSES.has(assignment.status),
      ),
    },
    {
      heading: t('visualisation.tray.completed'),
      rows: numbered.filter(
        ({ assignment }) => !IN_PROGRESS_STATUSES.has(assignment.status),
      ),
    },
  ].filter((section) => section.rows.length > 0);

  return (
    <>
      <TrayHeading id={headingId} action={headingAction}>
        {t('visualisation.tray.taskHeading', { shortcode: task.shortcode })}
      </TrayHeading>
      <ExpandableText
        text={task.request}
        variant="ellipsis"
        expandLabel={t('visualisation.tray.prompt.expand')}
        collapseLabel={t('visualisation.tray.prompt.collapse')}
      />
      <p>{statusLabel(task.status)}</p>
      {sections.map((section) => (
        <Fragment key={section.heading}>
          <h3>{section.heading}</h3>
          <ol>
            {section.rows.map(({ assignment, number }) => (
              // The native marker shows `value`, so the number seen and the
              // number read agree even where the section has gaps.
              <li key={assignment.id} value={number}>
                {t('visualisation.tray.assignmentRow', {
                  role: roleName(assignment.roleId),
                  mode: modeLabel(assignment.mode),
                })}{' '}
                <AssignmentInfo
                  shortcode={task.shortcode}
                  number={number}
                  prompt={assignment.prompt}
                  portalContainer={portalContainer}
                />
                {t('visualisation.tray.assignmentStatusSuffix', {
                  status: statusLabel(assignment.status),
                })}
              </li>
            ))}
          </ol>
        </Fragment>
      ))}
    </>
  );
};
