import { useEffect, useState } from 'react';
import { Button } from 'react-aria-components';
import { refusalKey, type RefusalAction } from '../../api/errors';
import {
  useCancelTask,
  useLiveTaskState,
  usePauseTask,
  useResumeTask,
  useStartTask,
} from '../../api/hooks';
import { ACTIVE_TASK_STATUSES } from '../../api/statuses';
import { t } from '../../strings';
import { ButtonRow } from '../ButtonRow/ButtonRow';
import { CreateTaskDialog } from '../CreateTaskDialog/CreateTaskDialog';
import { ConfirmDialog } from '../Dialog/ConfirmDialog';
import { ErrorState } from '../ErrorState/ErrorState';
import { RESUMABLE_KINDS, useTaskWaiting } from './useTaskWaiting';

export interface TaskControlsProps {
  readonly taskId: string;
  readonly companyId: string;
  /**
   * Where focus goes when the control that had it disappears (Start, once
   * the task has started). Without it, focus would drop to the page body,
   * which ADR-027 forbids leaving it on.
   */
  readonly focusFallback: () => HTMLElement | null;
  /** Where its dialogs are portalled; see `DialogProps.portalContainer`. */
  readonly portalContainer?: Element | undefined;
}

/**
 * Start, edit, pause, resume and cancel a task, each shown only in the states
 * where the server would accept it, with Cancel behind a confirmation. Shared
 * by the task dialog and the office view's tray, so both offer the same
 * controls.
 */
export const TaskControls = ({
  taskId,
  companyId,
  focusFallback,
  portalContainer,
}: TaskControlsProps) => {
  const task = useLiveTaskState(taskId);
  const { waiting } = useTaskWaiting(taskId, companyId);
  const cancel = useCancelTask(taskId);
  const start = useStartTask(taskId);
  const pause = usePauseTask(taskId);
  const resume = useResumeTask(taskId);
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);

  const taskData = task.data;
  const isActive =
    taskData !== undefined &&
    (ACTIVE_TASK_STATUSES as readonly string[]).includes(taskData.status);
  const isPaused = Boolean(taskData?.pausedAt);
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
    // drops focus onto the page body. Only the body, deliberately: React
    // Aria's focus scope often catches this itself, and when it has, focus is
    // already somewhere deliberate and must not be moved again. Keyed on the
    // set of controls, a value, so StrictMode's second run is harmless.
    if (document.activeElement !== document.body) return;
    focusFallback()?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the controls changing, not to a new fallback function each render
  }, [controls]);

  if (taskData === undefined) return null;

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
    <>
      {controls !== '' && (
        <ButtonRow>
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
              className="react-aria-Button tcp-button--outline"
              isDisabled={cancel.isPending}
              onPress={() => {
                setConfirming(true);
              }}
            >
              {t('task.cancel')}
            </Button>
          )}
        </ButtonRow>
      )}

      {editing && (
        <CreateTaskDialog
          companyId={companyId}
          task={taskData}
          portalContainer={portalContainer}
          onClose={() => {
            setEditing(false);
          }}
        />
      )}

      <ConfirmDialog
        isOpen={confirming}
        heading={t('task.cancel.confirm.heading')}
        message={t('task.cancel.confirm.body')}
        confirmLabel={t('task.cancel.confirm.accept')}
        cancelLabel={t('task.cancel.confirm.reject')}
        portalContainer={portalContainer}
        onConfirm={() => {
          setConfirming(false);
          cancel.mutate();
        }}
        onCancel={() => {
          setConfirming(false);
        }}
      />

      {failure('start', start)}
      {failure('pause', pause)}
      {failure('resume', resume)}
      {failure('cancel', cancel)}
    </>
  );
};
