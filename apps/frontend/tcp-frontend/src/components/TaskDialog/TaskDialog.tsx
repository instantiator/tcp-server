import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from 'react-aria-components';
import { announce } from '../../announce/announcer';
import { useLoadingAnnouncement } from '../../announce/useLoadingAnnouncement';
import {
  useCancelTask,
  useCompanyRolesList,
  useLiveAssignmentsList,
  useLiveTaskState,
} from '../../api/hooks';
import { ACTIVE_TASK_STATUSES, statusLabel } from '../../api/statuses';
import { streamUrls } from '../../events/subscriptions';
import { useEventStream } from '../../events/useEventStream';
import { t } from '../../strings';
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

/**
 * A task: its details, one collapsible panel per assignment, and a confirmed
 * control to cancel it.
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

  // The dialog's own stream, and the only one it opens itself: it carries
  // this task's changes and its assignments'. `applyEvent` folds both into
  // the query cache, so no `onEvent` callback is needed here. Every other
  // stream in this dialog belongs to a mounted `<Transcript/>`.
  useEventStream(streamUrls.task(taskId));

  const detailsHeadingId = useId();
  const detailsRef = useRef<HTMLElement | null>(null);

  const [confirming, setConfirming] = useState(false);
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

  const canCancel =
    task.data !== undefined &&
    (ACTIVE_TASK_STATUSES as readonly string[]).includes(task.data.status);

  useEffect(() => {
    if (canCancel) return;
    // The cancel button has just been removed, and a focused element that
    // disappears drops focus onto the page body — which ADR-027 forbids
    // leaving it on. Only the body, deliberately: React Aria's focus scope
    // often catches this itself, and when it has, focus is already somewhere
    // deliberate and must not be moved again.
    if (document.activeElement !== document.body) return;
    detailsRef.current?.focus();
  }, [canCancel]);

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
            {task.data.failureReason !== null && (
              <p className="task-dialog__field">
                <span className="task-dialog__field-label">
                  {t('task.details.failureReason')}
                </span>
                {task.data.failureReason}
              </p>
            )}
          </section>

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

          {cancel.isError && (
            <ErrorState
              message={t('task.cancel.failed')}
              channel={`task-cancel:${taskId}`}
            />
          )}
        </>
      )}
    </Dialog>
  );
};
