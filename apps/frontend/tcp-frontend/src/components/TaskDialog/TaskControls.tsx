import { Pause, Pencil, Play, Square, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
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
import { t, type StringKey } from '../../strings';
import { ButtonRow } from '../ButtonRow/ButtonRow';
import { CreateTaskDialog } from '../CreateTaskDialog/CreateTaskDialog';
import { ConfirmDialog } from '../Dialog/ConfirmDialog';
import { ErrorState } from '../ErrorState/ErrorState';
import { RoundIconButton } from '../RoundIconButton/RoundIconButton';
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
  /**
   * Small round icon buttons, named for the task ("Pause task 002"), instead
   * of text buttons — for the office tray's action row.
   */
  readonly icons?: boolean;
  /** Further icon buttons drawn in the same row, after these (the tray's Close room). */
  readonly extraActions?: ReactNode;
}

/** One control, drawn either way. */
interface Control {
  readonly id: string;
  readonly text: StringKey;
  /** The icon variant's name, which takes `{shortcode}`. */
  readonly iconLabel: StringKey;
  readonly icon: LucideIcon;
  readonly outline?: boolean;
  readonly isDisabled?: boolean;
  readonly onPress: () => void;
}

/**
 * Start, edit, pause, resume and cancel a task, each shown only in the states
 * where the server would accept it, with Cancel behind a confirmation. Shared
 * by the task dialog (text buttons) and the office view's tray (`icons`), so
 * both offer the same controls.
 */
export const TaskControls = ({
  taskId,
  companyId,
  focusFallback,
  portalContainer,
  icons = false,
  extraActions,
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

  const candidates: (Control | false)[] = [
    canStart && {
      id: 'start',
      text: 'task.start',
      iconLabel: 'task.start.icon',
      icon: Play,
      isDisabled: start.isPending,
      onPress: () => {
        start.mutate();
      },
    },
    canEdit && {
      id: 'edit',
      text: 'task.edit',
      iconLabel: 'task.edit.icon',
      icon: Pencil,
      onPress: () => {
        setEditing(true);
      },
    },
    canPause && {
      id: 'pause',
      text: 'task.pause',
      iconLabel: 'task.pause.icon',
      icon: Pause,
      isDisabled: pause.isPending,
      onPress: () => {
        pause.mutate();
      },
    },
    canResume && {
      id: 'resume',
      text: 'task.resume',
      iconLabel: 'task.resume.icon',
      icon: Play,
      isDisabled: resume.isPending,
      onPress: () => {
        resume.mutate();
      },
    },
    canCancel && {
      id: 'cancel',
      text: 'task.cancel',
      iconLabel: 'task.cancel.icon',
      icon: Square,
      outline: true,
      isDisabled: cancel.isPending,
      onPress: () => {
        setConfirming(true);
      },
    },
  ];
  const shown = candidates.filter(
    (control): control is Control => control !== false,
  );

  return (
    <>
      {icons
        ? (shown.length > 0 || extraActions !== undefined) && (
            <div className="task-controls--icons">
              {shown.map((control) => (
                <RoundIconButton
                  key={control.id}
                  icon={control.icon}
                  label={t(control.iconLabel, {
                    shortcode: taskData.shortcode,
                  })}
                  outline={control.outline}
                  isDisabled={control.isDisabled}
                  portalContainer={portalContainer}
                  onPress={control.onPress}
                />
              ))}
              {extraActions}
            </div>
          )
        : shown.length > 0 && (
            <ButtonRow>
              {shown.map((control) => (
                <Button
                  key={control.id}
                  className={
                    control.outline === true
                      ? 'react-aria-Button tcp-button--outline'
                      : 'react-aria-Button'
                  }
                  isDisabled={control.isDisabled}
                  onPress={control.onPress}
                >
                  {t(control.text)}
                </Button>
              ))}
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
