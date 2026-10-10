import { useEffect, useRef, useState } from 'react';
import { Button } from 'react-aria-components';
import './ShutdownDialog.css';
import { announce } from '../../announce/announcer';
import { refusalKey } from '../../api/errors';
import {
  useBeginShutdown,
  useCancelShutdown,
  useShutdownStatus,
} from '../../api/hooks';
import { t, tCount } from '../../strings';
import { Dialog } from '../Dialog/Dialog';
import { ErrorState } from '../ErrorState/ErrorState';
import { LoadingState } from '../LoadingState/LoadingState';

export interface ShutdownDialogProps {
  readonly onClose: () => void;
}

/** What the dialog is telling the administrator, which decides its controls. */
type Situation =
  | 'idle'
  | 'restarted'
  | 'draining'
  | 'restartDraining'
  | 'quiesced'
  | 'restarting';

/**
 * Shuts the system down gracefully, restarts it, or forces it down — and shows
 * what is happening while it does.
 *
 * **A restart takes the server away, so a failed status call after a restart
 * was seen is not an error here: it is the restart.** The dialog keeps polling
 * and reports the return to idle as "The system restarted".
 *
 * **Force is behind a confirmation** because it wastes the tokens agents have
 * already spent; it is never one press from the idle buttons.
 *
 * Accessibility: a change of situation is announced once (not on every poll,
 * and the agent count is left out of the announcement for that reason), and
 * focus moves to the status text when the buttons change, so a control that
 * disappears does not leave focus on the page body.
 */
export const ShutdownDialog = ({ onClose }: ShutdownDialogProps) => {
  const status = useShutdownStatus(true);
  const begin = useBeginShutdown();
  const cancel = useCancelShutdown();
  const [confirmingForce, setConfirmingForce] = useState(false);
  const [restartSeen, setRestartSeen] = useState(false);
  const messageRef = useRef<HTMLParagraphElement>(null);

  const { data } = status;
  // Remembered in state, set while rendering, so it survives the status
  // going away and coming back as a plain idle.
  if (data?.restart === true && !restartSeen) setRestartSeen(true);

  let situation: Situation | null = null;
  if (status.isError && restartSeen) situation = 'restarting';
  else if (data !== undefined) {
    if (data.state === 'idle') situation = restartSeen ? 'restarted' : 'idle';
    else if (data.state === 'draining')
      situation = data.restart ? 'restartDraining' : 'draining';
    else situation = data.restart ? 'restarting' : 'quiesced';
  }

  const previous = useRef<{ situation: Situation; confirming: boolean } | null>(
    null,
  );
  useEffect(() => {
    if (situation === null) return;
    const before = previous.current;
    previous.current = { situation, confirming: confirmingForce };
    if (before === null) return;
    if (before.situation !== situation) {
      announce({
        channel: 'shutdown',
        change: `shutdown.announce.${situation}`,
      });
    }
    // The buttons just changed under the user's focus.
    if (
      before.situation !== situation ||
      before.confirming !== confirmingForce
    ) {
      messageRef.current?.focus();
    }
  }, [situation, confirmingForce]);

  const act = (run: () => void) => {
    setConfirmingForce(false);
    setRestartSeen(false);
    begin.reset();
    cancel.reset();
    run();
  };

  const failed = begin.isError || cancel.isError;
  const failure = begin.isError ? begin.error : cancel.error;
  const restartSupported = data?.restartSupported === true;
  const agents = data?.agentsRunning ?? 0;

  const message = (() => {
    if (confirmingForce) return t('shutdown.forceConfirm');
    switch (situation) {
      case 'draining':
        return tCount('shutdown.draining', agents);
      case 'restartDraining':
        return tCount('shutdown.restartDraining', agents);
      case 'quiesced':
        return t('shutdown.quiesced');
      case 'restarting':
        return t('shutdown.restarting');
      case 'restarted':
        return t('shutdown.restarted');
      default:
        return t('shutdown.explain');
    }
  })();

  const idleButtons = (
    <div className="shutdown-dialog__actions">
      {restartSupported && (
        <Button
          className="react-aria-Button"
          onPress={() => {
            act(() => {
              begin.mutate({ force: false, restart: true });
            });
          }}
        >
          {t('shutdown.restart')}
        </Button>
      )}
      <Button
        className="react-aria-Button"
        onPress={() => {
          act(() => {
            begin.mutate({ force: false, restart: false });
          });
        }}
      >
        {t('shutdown.graceful')}
      </Button>
      <Button
        className="react-aria-Button tcp-button--outline"
        onPress={() => {
          setConfirmingForce(true);
        }}
      >
        {t('shutdown.force')}
      </Button>
    </div>
  );

  const cancelButton = (label: string) => (
    <Button
      className="react-aria-Button"
      onPress={() => {
        act(() => {
          cancel.mutate();
        });
      }}
    >
      {label}
    </Button>
  );

  const isIdle = situation === 'idle' || situation === 'restarted';

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      heading={t('shutdown.heading')}
    >
      {status.isPending && <LoadingState label={t('shutdown.loading')} />}

      {situation === null && status.isError && (
        <ErrorState
          message={t('shutdown.error')}
          channel="shutdown"
          onRetry={() => {
            void status.refetch();
          }}
        />
      )}

      {situation !== null && (
        <>
          <p ref={messageRef} tabIndex={-1}>
            {message}
          </p>
          {isIdle && !confirmingForce && (
            <>
              {situation === 'restarted' && <p>{t('shutdown.explain')}</p>}
              {restartSupported && <p>{t('shutdown.explainRestart')}</p>}
            </>
          )}
          {isIdle && !confirmingForce && idleButtons}
          {isIdle && confirmingForce && (
            <div className="shutdown-dialog__actions">
              <Button
                className="react-aria-Button"
                onPress={() => {
                  act(() => {
                    begin.mutate({ force: true, restart: false });
                  });
                }}
              >
                {t('shutdown.forceConfirmed')}
              </Button>
              <Button
                className="react-aria-Button"
                onPress={() => {
                  setConfirmingForce(false);
                }}
              >
                {t('shutdown.back')}
              </Button>
            </div>
          )}
          {situation === 'draining' && cancelButton(t('shutdown.cancel'))}
          {situation === 'quiesced' && cancelButton(t('shutdown.cancel'))}
          {situation === 'restartDraining' &&
            cancelButton(t('shutdown.cancelRestart'))}
        </>
      )}

      {failed && (
        <ErrorState
          message={t(refusalKey(failure, 'shutdown'))}
          channel="shutdown-action"
        />
      )}
    </Dialog>
  );
};
