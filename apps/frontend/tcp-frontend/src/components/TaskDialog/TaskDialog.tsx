import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from 'react-aria-components';
import { announce } from '../../announce/announcer';
import { useLoadingAnnouncement } from '../../announce/useLoadingAnnouncement';
import type { TaskWaiting } from '@tcp/shared/client';
import { taskWaiting } from '@tcp/shared/client';
import { refusalKey, type RefusalAction } from '../../api/errors';
import {
  useCancelTask,
  useCompanyRolesList,
  useLiveAssignmentsList,
  useLiveCompanyAgentsList,
  useLiveTaskState,
  usePauseTask,
  useResumeTask,
  useStartTask,
} from '../../api/hooks';
import {
  ACTIVE_TASK_STATUSES,
  statusLabel,
  taskWaitingLabel,
} from '../../api/statuses';
import { streamUrls } from '../../events/subscriptions';
import { useEventStream } from '../../events/useEventStream';
import { t } from '../../strings';
import { CreateTaskDialog } from '../CreateTaskDialog/CreateTaskDialog';
import { Dialog } from '../Dialog/Dialog';
import { EmptyState } from '../EmptyState/EmptyState';
import { ErrorState } from '../ErrorState/ErrorState';
import { LoadingState } from '../LoadingState/LoadingState';
import { TaskAssignmentPanel } from './TaskAssignmentPanel';
import './TaskDialog.css';

export interface TaskDialogProps {
  readonly taskId: string;
  /** Known by the opener, so the roles query does not have to wait for the task. */
  readonly companyId: string;
  readonly onClose: () => void;
}

/** Waiting kinds a user can act on with Resume, even without pausing the task. */
const RESUMABLE_KINDS: readonly TaskWaiting['kind'][] = [
  'spend_cap',
  'shutdown',
  'rate_limited',
  'manual',
  'restart',
];

/**
 * A task: its details, why it is waiting (if it is), one collapsible panel per
 * assignment, and controls to start, edit, pause, resume or cancel it — each
 * shown only in the states where the server would accept it.
 *
 * **A plain modal, not a parkable one.** Unlike the chat dialog (008.02), a
 * task dialog holds nothing the user has authored, so there is nothing to
 * preserve by minimising it — it opens, and it closes. `isOpen` is a literal
 * `true`: the opener mounts this component only while a task is open, and
 * unmounting it is what closes it.
 *
 * **Assignments come from `useLiveAssignmentsList({ taskId })`, not from
 * `useLiveTaskState(taskId).data.assignments`.** The task detail route does
 * return `assignments` nested, but the live-event cache patches a cached row
 * by matching its *top-level* `id` (`applyEvent` in `src/events/cache.ts`), and
 * an `assignment` event carries the assignment's id, not the task's — so the
 * nested array is never patched and never gains a row when the planner fans
 * the task out further. The flat assignments list is patched correctly by the
 * same mechanism.
 */
export const TaskDialog = ({ taskId, companyId, onClose }: TaskDialogProps) => {
  const task = useLiveTaskState(taskId);
  const assignments = useLiveAssignmentsList({ taskId });
  const { data: roles } = useCompanyRolesList(companyId);
  const cancel = useCancelTask(taskId);
  const start = useStartTask(taskId);
  const pause = usePauseTask(taskId);
  const resume = useResumeTask(taskId);
  const { data: companyAgents } = useLiveCompanyAgentsList(companyId);

  // The dialog's own stream, and the only one it opens itself: it carries
  // this task's changes and its assignments'. `applyEvent` folds both into
  // the query cache, so no `onEvent` callback is needed here. Every other
  // stream in this dialog belongs to a mounted `<Transcript/>`.
  useEventStream(streamUrls.task(taskId));

  const detailsHeadingId = useId();
  const detailsRef = useRef<HTMLElement | null>(null);

  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );

  const toggleExpanded = (assignmentId: string): void => {
    setExpandedIds((previous) => {
      const next = new Set(previous);
      if (next.has(assignmentId)) {
        next.delete(assignmentId);
      } else {
        next.add(assignmentId);
      }
      return next;
    });
  };

  // Assignment rows carry only `roleId`. A shared component must not reach
  // into a page's own directory for `roleLabel`
  // (`src/pages/CompanyPage/activity/activity-list-utils.ts`), the same
  // layering rule that moved `statusLabel` into `src/api/statuses.ts`.
  const roleName = (roleId: string): string =>
    roles?.find((role) => role.id === roleId)?.name ??
    t('activity.role.unknown');

  // Sorted on immutable fields only, so a status change never reshuffles the
  // panels the user is looking at.
  const ordered = useMemo(
    () =>
      [...(assignments.data ?? [])].sort((a, b) =>
        a.createdAt === b.createdAt
          ? a.id.localeCompare(b.id)
          : a.createdAt.localeCompare(b.createdAt),
      ),
    [assignments.data],
  );

  // Seeded silently: the first pass records what is already on screen, so
  // opening the dialog is not read out as N status changes. StrictMode's
  // second invocation sees the same values and announces nothing, which is
  // why this keys on the status itself rather than on a "have I run?" boolean.
  const seenAssignmentStatuses = useRef(new Map<string, string>());

  useEffect(() => {
    for (const assignment of ordered) {
      const previous = seenAssignmentStatuses.current.get(assignment.id);
      seenAssignmentStatuses.current.set(assignment.id, assignment.status);
      if (previous === undefined || previous === assignment.status) continue;
      announce({
        channel: `task:${taskId}`,
        change: 'task.announce.assignment',
        params: {
          role: roleName(assignment.roleId),
          status: statusLabel(assignment.status),
        },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- roleName reads `roles`, not tracked here: the phrase it builds is a courtesy, not the change being announced.
  }, [ordered, taskId]);

  const seenTaskStatus = useRef<string | null>(null);
  const taskStatus = task.data?.status;

  useEffect(() => {
    if (taskStatus === undefined) return;
    const previous = seenTaskStatus.current;
    seenTaskStatus.current = taskStatus;
    if (previous === null || previous === taskStatus) return;
    announce({
      channel: `task:${taskId}`,
      change: 'task.announce.status',
      params: { status: statusLabel(taskStatus) },
    });
  }, [taskStatus, taskId]);

  useLoadingAnnouncement(
    task.isPending,
    task.data === undefined
      ? null
      : {
          channel: `task:${taskId}`,
          change: 'task.announce.loaded',
          params: { shortcode: task.data.shortcode },
        },
  );

  const taskData = task.data;
  const isActive =
    taskData !== undefined &&
    (ACTIVE_TASK_STATUSES as readonly string[]).includes(taskData.status);
  const isPaused = Boolean(taskData?.pausedAt);

  // Worked out here from the live agents rather than read from the detail
  // fetch's `waiting`, which is only as fresh as the last refetch.
  const taskAgents = useMemo(() => {
    const ids = new Set(assignments.data?.map((a) => a.id));
    return (companyAgents ?? []).filter((a) => ids.has(a.assignmentId));
  }, [companyAgents, assignments.data]);
  const waiting =
    taskData === undefined ? null : taskWaiting(taskData, taskAgents);
  const isPausing = isPaused && taskAgents.some((a) => a.status === 'running');

  const canStart = taskData?.status === 'ready';
  const canEdit = canStart;
  // `ACTIVE_TASK_STATUSES` includes `ready`, which has nothing to pause.
  const isRunning = isActive && !canStart;
  const canPause = isRunning && !isPaused;
  const canResume =
    isRunning &&
    (isPaused || (waiting !== null && RESUMABLE_KINDS.includes(waiting.kind)));
  const canCancel = isActive;

  const controls = [
    canStart && 'start',
    canEdit && 'edit',
    canPause && 'pause',
    canResume && 'resume',
    canCancel && 'cancel',
  ]
    .filter(Boolean)
    .join();

  useEffect(() => {
    // A control has just been removed, and a focused element that disappears
    // drops focus onto the page body — which ADR-027 forbids leaving it on.
    // Only the body, deliberately: React Aria's focus scope often catches this
    // itself, and when it has, focus is already somewhere deliberate and must
    // not be moved again. Keyed on the set of controls, a value, so StrictMode's
    // second run is harmless.
    if (document.activeElement !== document.body) return;
    detailsRef.current?.focus();
  }, [controls]);

  const failure = (
    action: RefusalAction,
    mutation: { isError: boolean; error: unknown },
  ) =>
    mutation.isError && (
      <ErrorState
        message={t(refusalKey(mutation.error, action))}
        channel={`task-${action}:${taskId}`}
      />
    );

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      heading={
        task.data === undefined
          ? t('task.dialog.heading.pending')
          : t('task.dialog.heading', { shortcode: task.data.shortcode })
      }
    >
      {task.isPending && <LoadingState label={t('task.loading')} />}

      {task.isError && (
        <ErrorState message={t('task.error')} channel={`task:${taskId}`} />
      )}

      {task.data !== undefined && (
        <>
          <section
            className="task-dialog__details"
            aria-labelledby={detailsHeadingId}
            tabIndex={-1}
            ref={detailsRef}
          >
            <h3 id={detailsHeadingId} className="task-dialog__details-heading">
              {t('task.details.label')}
            </h3>
            <p className="task-dialog__field">
              <span className="task-dialog__field-label">
                {t('task.details.request')}
              </span>
              {task.data.request}
            </p>
            <p className="task-dialog__field">
              <span className="task-dialog__field-label">
                {t('task.details.status')}
              </span>
              {statusLabel(task.data.status)}
            </p>
            {(isPausing || waiting !== null) && (
              <p className="task-dialog__field">
                <span className="task-dialog__field-label">
                  {t('task.details.waiting')}
                </span>
                {isPausing
                  ? t('task.details.pausing')
                  : waiting !== null && taskWaitingLabel(waiting)}
              </p>
            )}
            {task.data.failureReason !== null && (
              <p className="task-dialog__field">
                <span className="task-dialog__field-label">
                  {t('task.details.failureReason')}
                </span>
                {task.data.failureReason}
              </p>
            )}
          </section>

          {canStart && (
            <Button
              className="react-aria-Button"
              isDisabled={start.isPending}
              onPress={() => {
                start.mutate();
              }}
            >
              {t('task.start')}
            </Button>
          )}
          {canEdit && (
            <Button
              className="react-aria-Button"
              onPress={() => {
                setEditing(true);
              }}
            >
              {t('task.edit')}
            </Button>
          )}
          {canPause && (
            <Button
              className="react-aria-Button"
              isDisabled={pause.isPending}
              onPress={() => {
                pause.mutate();
              }}
            >
              {t('task.pause')}
            </Button>
          )}
          {canResume && (
            <Button
              className="react-aria-Button"
              isDisabled={resume.isPending}
              onPress={() => {
                resume.mutate();
              }}
            >
              {t('task.resume')}
            </Button>
          )}
          {canCancel && (
            <Button
              className="react-aria-Button task-dialog__cancel"
              isDisabled={cancel.isPending}
              onPress={() => {
                setConfirming(true);
              }}
            >
              {t('task.cancel')}
            </Button>
          )}

          {editing && (
            <CreateTaskDialog
              companyId={companyId}
              task={task.data}
              onClose={() => {
                setEditing(false);
              }}
            />
          )}

          <Dialog
            isOpen={confirming}
            onOpenChange={(open) => {
              if (!open) setConfirming(false);
            }}
            heading={t('task.cancel.confirm.heading')}
          >
            <p>{t('task.cancel.confirm.body')}</p>
            <div className="task-dialog__confirm-actions">
              <Button
                className="react-aria-Button"
                onPress={() => {
                  setConfirming(false);
                  cancel.mutate();
                }}
              >
                {t('task.cancel.confirm.accept')}
              </Button>
              <Button
                className="react-aria-Button"
                onPress={() => {
                  setConfirming(false);
                }}
              >
                {t('task.cancel.confirm.reject')}
              </Button>
            </div>
          </Dialog>

          <h3 className="task-dialog__assignments-heading">
            {t('task.assignments.heading')}
          </h3>
          {ordered.length === 0 ? (
            <EmptyState
              heading={t('task.assignments.empty.heading')}
              headingLevel={3}
            >
              {t('task.assignments.empty.body')}
            </EmptyState>
          ) : (
            ordered.map((assignment) => (
              <TaskAssignmentPanel
                key={assignment.id}
                agentId={assignment.agentId ?? null}
                roleName={roleName(assignment.roleId)}
                status={assignment.status}
                isExpanded={expandedIds.has(assignment.id)}
                onToggle={() => {
                  toggleExpanded(assignment.id);
                }}
              />
            ))
          )}

          {failure('start', start)}
          {failure('pause', pause)}
          {failure('resume', resume)}
          {failure('cancel', cancel)}
        </>
      )}
    </Dialog>
  );
};
