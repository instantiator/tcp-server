import { useState, type SubmitEvent } from 'react';
import { Button, Input, Label, TextField } from 'react-aria-components';
import { useLiveAgentState, useSendMessage } from '../../api/hooks';
import { t } from '../../strings';
import { ErrorState } from '../ErrorState/ErrorState';

export interface MessageInputProps {
  /** The agent the message goes to. */
  readonly agentId: string;
  /** The agent's role, for the field label and the waiting line. */
  readonly roleName: string;
}

/**
 * The form at the bottom of one chat panel: a single-line message field, a
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
 * stream the transcript beside this is already watching — so
 * `useLiveAgentState` is live here without opening anything of its own. The
 * mutation's own pending state covers the moment before the first of those
 * events lands.
 */
export const MessageInput = ({ agentId, roleName }: MessageInputProps) => {
  const send = useSendMessage(agentId);
  const { data: agent } = useLiveAgentState({ agentId });

  const [value, setValue] = useState('');

  // One state, two sources: the request is in flight, or the agent has told us
  // it is working. Typing a second message into a turn that is still running
  // would be sent and then queued behind the first, which reads as the field
  // having eaten it.
  const waiting = send.isPending || agent?.status === 'running';

  const handleSubmit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
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
      <TextField
        className="react-aria-TextField chat-input__field"
        value={value}
        onChange={setValue}
        isDisabled={waiting}
      >
        <Label className="react-aria-Label">
          {t('chat.message.label', { role: roleName })}
        </Label>
        {/* ponytail: single-line input, so Enter-to-send is the browser's. A
            multi-line composer needs its own key handling — add it when
            someone asks. */}
        <Input className="react-aria-Input" />
      </TextField>
      <Button
        type="submit"
        className="react-aria-Button chat-input__send"
        isDisabled={waiting}
      >
        {t('chat.send')}
      </Button>
      {/*
        Never a live region — no `role="status"`, no `aria-live`. ADR-027
        allows exactly one live region in the whole application (the
        announcer), and `useTranscript` already announces the completed
        response on its own channel. A second spoken source for the same event
        would say it twice. This is also the visible reason the field is
        disabled, which a disabled control has to have.
      */}
      {waiting === true && (
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
