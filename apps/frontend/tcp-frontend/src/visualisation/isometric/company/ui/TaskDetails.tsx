import {
  useCloseTaskVisualisation,
  useLiveAssignmentsList,
  useLiveCompanyState,
  useLiveCompanyTasksList,
  useCompanyRolesList,
} from '../../../../api/hooks';
import { refusalKey } from '../../../../api/errors';
import { taskOutputsUrl } from '../../../../api/storageLink';
import { ErrorState } from '../../../../components/ErrorState/ErrorState';
import { TaskControls } from '../../../../components/TaskDialog/TaskControls';
import { getRuntimeConfig } from '../../../../runtime-config';
import type { AssignmentDTO } from '../../../../api/dtos';
import { ChevronRight, DoorClosed, Ear } from 'lucide-react';
import { Icon } from '../../../../components/Icon/Icon';
import { RoundIconButton } from '../../../../components/RoundIconButton/RoundIconButton';
import { ACTIVE_TASK_STATUSES } from '../../../../api/statuses';
import { ExpandableText } from '../../../../components/ExpandableText/ExpandableText';
import { t } from '../../../../strings';
import { modeLabel } from './modeLabel';
import { StatusIcon } from './StatusIcon';
import { TrayPanel } from './TrayPanel';
import { useListenIn } from './useListenIn';

export interface TaskDetailsProps {
  readonly companyId: string;
  readonly taskId: string;
  readonly headingId: string;
  /**
   * Called once the task's room has closed, so the tray can let go of a
   * selection whose whiteboard has gone and put focus somewhere deliberate.
   */
  readonly onRoomClosed?: () => void;
  /** Where the assignment tooltips are portalled; see `VisualisationTrayProps.portalContainer`. */
  readonly portalContainer?: Element | undefined;
}

/** Chronological: oldest first, with the id as a stable tie-break. */
const byCreation = (a: AssignmentDTO, b: AssignmentDTO): number =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/** An assignment whose agent is at work now: its Listen in is filled. */
const WORKING_STATUSES: ReadonlySet<string> = new Set(['in-progress', 'in-qa']);

/**
 * The link to a succeeded task's outputs in Silo, marked up as the archive's
 * rows are: the visible text leads the accessible name and a hidden suffix
 * warns of the new tab (WCAG 2.5.3). Without storage configured, or before
 * the company has loaded, there is no URL, so it says why instead.
 */
const OutputsLink = ({
  slug,
  taskId,
}: {
  readonly slug: string | undefined;
  readonly taskId: string;
}) => {
  const url =
    slug === undefined
      ? null
      : taskOutputsUrl(getRuntimeConfig(), slug, taskId);
  if (url === null) {
    return slug === undefined ? null : (
      <p>{t('visualisation.tray.outputsUnconfigured')}</p>
    );
  }
  return (
    <p>
      <a href={url} target="_blank" rel="noopener noreferrer">
        {t('visualisation.tray.outputs')}{' '}
        <span className="visually-hidden">
          {t('visualisation.archive.linkSuffix')}
        </span>
      </a>
    </p>
  );
};

/**
 * One task's live details in the office tray (000.06.03): its status as an
 * icon in the heading, the task dialog's controls as icon actions (plus Close
 * room once it has finished), its request as the description, and its
 * assignments in creation order.
 *
 * Each assignment row reads: status, mode, then its role as a disclosure
 * (native `<details>`, like the transcript's reasoning) that reveals the
 * assignment's prompt, then Listen in — filled while its agent is working,
 * outlined once it has finished, and absent before it has started.
 *
 * Assignments come from the company's whole list, filtered to this task
 * client-side — the same list `useOfficeWorld` already holds for the rules,
 * rather than a second, task-scoped query for the same rows.
 */
export const TaskDetails = ({
  companyId,
  taskId,
  headingId,
  onRoomClosed,
  portalContainer,
}: TaskDetailsProps) => {
  const tasksQuery = useLiveCompanyTasksList(companyId);
  const { data: roles } = useCompanyRolesList(companyId);
  const { data: assignments } = useLiveAssignmentsList({ companyId });
  const companyQuery = useLiveCompanyState(companyId);
  const closeRoom = useCloseTaskVisualisation(taskId);
  const listenIn = useListenIn(companyId);

  if (tasksQuery.isPending) {
    return (
      <TrayPanel
        headingId={headingId}
        heading={t('visualisation.tray.heading')}
      >
        <p>{t('visualisation.tray.loading')}</p>
      </TrayPanel>
    );
  }

  const task = tasksQuery.data?.find((candidate) => candidate.id === taskId);
  if (task === undefined) {
    return (
      <TrayPanel
        headingId={headingId}
        heading={t('visualisation.tray.heading')}
      >
        <p>{t('visualisation.tray.gone')}</p>
      </TrayPanel>
    );
  }

  const roleName = (roleId: string): string =>
    roles?.find((role) => role.id === roleId)?.name ??
    t('activity.role.unknown');

  const rows = (assignments ?? [])
    .filter((assignment) => assignment.taskId === taskId)
    .sort(byCreation);

  const finished = !(ACTIVE_TASK_STATUSES as readonly string[]).includes(
    task.status,
  );
  const canCloseRoom = finished && !task.visualisationClosedAt;

  return (
    <TrayPanel
      headingId={headingId}
      icon={<StatusIcon status={task.status} paused={task.pausedAt !== null} />}
      heading={t('visualisation.tray.taskHeading', {
        shortcode: task.shortcode,
      })}
      actions={
        <TaskControls
          taskId={taskId}
          companyId={companyId}
          portalContainer={portalContainer}
          focusFallback={() => document.getElementById(headingId)}
          icons
          extraActions={
            canCloseRoom ? (
              <RoundIconButton
                icon={DoorClosed}
                label={t('visualisation.tray.closeRoom')}
                portalContainer={portalContainer}
                isDisabled={closeRoom.isPending}
                onPress={() => {
                  closeRoom.mutate(undefined, { onSuccess: onRoomClosed });
                }}
              />
            ) : undefined
          }
        />
      }
      description={
        <ExpandableText
          text={task.request}
          variant="icon"
          expandLabel={t('visualisation.tray.prompt.expand')}
          collapseLabel={t('visualisation.tray.prompt.collapse')}
          portalContainer={portalContainer}
        />
      }
    >
      {task.status === 'succeeded' && (
        <OutputsLink slug={companyQuery.data?.slug} taskId={taskId} />
      )}
      {closeRoom.isError && (
        <ErrorState
          message={t(refusalKey(closeRoom.error, 'closeVisualisation'))}
          channel={`task-closeVisualisation:${taskId}`}
        />
      )}
      {rows.length > 0 && (
        <>
          <h3>{t('visualisation.tray.assignments')}</h3>
          <ol className="tray-assignments">
            {rows.map((assignment, index) => {
              const number = index + 1;
              const role = roleName(assignment.roleId);
              const agentId = assignment.agentId ?? null;
              const working = WORKING_STATUSES.has(assignment.status);
              const canListen =
                agentId !== null && assignment.status !== 'ready';
              return (
                <li key={assignment.id} className="tray-assignments__row">
                  <StatusIcon status={assignment.status} />
                  <div className="tray-assignments__text">
                    <span className="tray-assignments__mode">
                      {number}. {modeLabel(assignment.mode)}
                    </span>
                    <details className="tray-assignments__details">
                      <summary>
                        {role}
                        <span className="visually-hidden">
                          {t('visualisation.tray.assignmentDescription', {
                            number,
                          })}
                        </span>
                        <Icon icon={ChevronRight} />
                      </summary>
                      <p>{assignment.prompt}</p>
                    </details>
                  </div>
                  {canListen && (
                    <RoundIconButton
                      icon={Ear}
                      outline={!working}
                      label={t('visualisation.tray.listenInAssignment', {
                        role,
                        number,
                      })}
                      portalContainer={portalContainer}
                      onPress={() => {
                        listenIn({
                          id: agentId,
                          roleId: assignment.roleId,
                          assignmentId: assignment.id,
                        });
                      }}
                    />
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </TrayPanel>
  );
};
