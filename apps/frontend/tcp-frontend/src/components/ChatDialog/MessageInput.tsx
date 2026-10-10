import { Send } from 'lucide-react';
import { useState, type SubmitEvent } from 'react';
import { Button, Input, Label, TextField } from 'react-aria-components';
import { useSendMessage } from '../../api/hooks';
import { t } from '../../strings';
import { ErrorState } from '../ErrorState/ErrorState';
import { Icon, WithTooltip } from '../Icon/Icon';
import { isTerminalAgentStatus } from './agentStatus';

export interface MessageInputProps {
  /** The agent the message goes to. */
  readonly agentId: string;
  /** The agent's role, for the field label and the waiting line. */
  readonly roleName: string;
  /**
   * The agent's live status, read once by `ChatView` and passed down.
   * `undefined` until it has been fetched, which reads as "not busy".
   */
  readonly status: string | undefined;
}

/**
 * The form at the bottom of a chat view: a single-line message field, a
 * send button, and a line saying when the agent owes a reply.
 *
 * **Sending returns immediately and the reply arrives on the event stream, not
 * in the response.** `POST /api/agent/{id}/message` answers `202` and the turn
 * runs detached, so without a waiting line the dialog would look like it had
 * simply swallowed the message.
 *
 * **What "waiting" means comes from the agent's own status, not from a timer
 * or from reading the transcript.** Sending sets the agent to `running` and
 * finishing a turn sets it back, and both transitions arrive on the very
 * stream the transcript beside this is already watching — so the status
 * `ChatView` hands down is live here without anything opening a
 * connection of its own. The mutation's own pending state covers the moment
 * before the first of those events lands.
 *
 * **A finished agent takes the form away rather than disabling it.** Waiting
 * ends; being over does not. Once the chat has been completed — or the agent
 * has failed or been cancelled — there is nothing on the other end to receive
 * a message, so the field and the send button go and a plain line says so.
 */
export const MessageInput = ({
  agentId,
  roleName,
  status,
}: MessageInputProps) => {
  const send = useSendMessage(agentId);

  const [value, setValue] = useState('');

  const finished = isTerminalAgentStatus(status);

  // One state, three sources: the chat is over, the request is in flight, or
  // the agent has told us it is working. Typing a second message into a turn
  // that is still running would be sent and then queued behind the first,
  // which reads as the field having eaten it.
  const waiting = send.isPending || status === 'running';
  const disabled = finished || waiting;

  const handleSubmit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    // Belt and braces: the controls below are gone once the chat is over, so
    // nothing should be able to submit — but a form can still be submitted by
    // other means, and a message sent into a completed chat would be refused
    // by the server with an error the user cannot act on.
    if (finished) return;
    // Ignored rather than shown as a validation error: an empty send is a
    // slip, not something the user meant and needs telling about.
    if (value.trim() === '') return;

    send.mutate(value, {
      // Cleared only on success. A failed send must leave the typed text
      // exactly where it was — the user should not have to retype it to press
      // Send again.
      onSuccess: () => {
        setValue('');
      },
    });
  };

  return (
    <form className="chat-input" onSubmit={handleSubmit}>
      {!finished && (
        <>
          <TextField
            className="react-aria-TextField chat-input__field"
            value={value}
            onChange={setValue}
            isDisabled={disabled}
          >
            <Label className="react-aria-Label">
              {t('chat.message.label', { role: roleName })}
            </Label>
            {/* ponytail: single-line input, so Enter-to-send is the browser's. A
                multi-line composer needs its own key handling — add it when
                someone asks. */}
            <Input className="react-aria-Input" />
          </TextField>
          <WithTooltip label={t('chat.send')}>
            <Button
              type="submit"
              className="react-aria-Button tcp-icon-button chat-input__send"
              aria-label={t('chat.send')}
              isDisabled={disabled}
            >
              <Icon icon={Send} />
            </Button>
          </WithTooltip>
        </>
      )}
      {/* Not a live region either, for the same reason as the waiting line
          below: this says why the form has gone, it does not narrate an
          arrival. */}
      {finished && <p className="chat-input__done">{t('chat.done')}</p>}
      {/*
        Never a live region — no `role="status"`, no `aria-live`. ADR-027
        allows exactly one live region in the whole application (the
        announcer), and `useTranscript` already announces the completed
        response on its own channel. A second spoken source for the same event
        would say it twice. This is also the visible reason the field is
        disabled, which a disabled control has to have.
      */}
      {!finished && waiting && (
        <p className="chat-input__waiting">
          {t('chat.waiting', { role: roleName })}
        </p>
      )}
      {send.isError && (
        <ErrorState
          message={t('chat.send.failed')}
          channel={`chat:${agentId}`}
        />
      )}
    </form>
  );
};
