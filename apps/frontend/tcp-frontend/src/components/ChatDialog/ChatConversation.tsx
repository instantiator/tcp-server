import { useEffect, useId, useRef } from 'react';
import { Button } from 'react-aria-components';
import { useCompleteChat, useLiveAgentState } from '../../api/hooks';
import { t } from '../../strings';
import { ErrorState } from '../ErrorState/ErrorState';
import { Transcript } from '../Transcript/Transcript';
import { isTerminalAgentStatus } from './agentStatus';
import { MessageInput } from './MessageInput';
import type { Conversation } from './useChat';

export interface ChatConversationProps {
  readonly conversation: Conversation;
  /**
   * Reports this panel's `<section>` element to `ChatDialog`, which keeps one
   * per conversation so it can move focus into any of them by agent id.
   * Called with `null` on unmount, same as any React ref callback.
   */
  readonly sectionRef: (element: HTMLElement | null) => void;
}

/**
 * One open conversation: its heading, a control to complete it, its transcript
 * and its message form.
 *
 * **Completing leaves the panel exactly where it is.** The chat is over, not
 * hidden: its transcript is still there to read and scroll, and only the
 * message form goes — there is nothing left to send a message to. A panel that
 * vanished on completion would take the record of the conversation with it,
 * and would move focus out from under whoever pressed the button.
 *
 * **The agent's live status is read once, here, and passed down.** Both the
 * complete button and the message form depend on it — one is disabled mid-turn,
 * the other is disabled for good once the agent is terminal — and a panel with
 * two independent reads of the same value is a panel that can disagree with
 * itself. TanStack dedupes the query either way; this is about one source of
 * truth, not about one request.
 *
 * **The heading is an `h3`, explicitly.** `ChatDialog` renders `<Dialog/>`,
 * whose own `<Heading slot="title">` is the `h2` naming the dialog as a
 * whole; each conversation inside it is one level down, the same reasoning
 * `ActivityList.tsx` gives for its own `h2` beside the page's `h1`. A default
 * heading level here would drift the outline every time this panel's parent
 * changes.
 *
 * **`tabIndex={-1}` on the section, not on anything inside it.** This is what
 * lets `ChatDialog` move focus straight to the panel as a whole. Focusing an
 * element labelled by its own heading (`aria-labelledby`) announces that
 * heading immediately, and it works whether or not the message field happens
 * to be enabled — focusing the field instead would say nothing while the
 * agent is busy and it is disabled.
 */
export const ChatConversation = ({
  conversation,
  sectionRef,
}: ChatConversationProps) => {
  const { agentId, roleName } = conversation;

  // A fresh id per panel: several conversations render at once, and each
  // needs its own heading id to label its own section correctly.
  const headingId = useId();

  const complete = useCompleteChat(agentId);
  const { data: agent } = useLiveAgentState({ agentId });
  const status = agent?.status;
  const finished = isTerminalAgentStatus(status);

  // This panel's own handle on its section, kept alongside the one reported
  // upwards: the focus move below is this component's to make, and reaching
  // back through `ChatDialog` for an element it already owns would be a
  // detour.
  const section = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!finished) return;
    // The complete button has just been removed, and a focused element that
    // disappears drops focus onto the page body — which ADR-027 forbids
    // leaving it on. Only the body, deliberately: React Aria's focus scope
    // often catches this itself, and when it has, focus is already somewhere
    // deliberate and must not be moved again. The panel is the right landing
    // place because it is labelled by its own heading, so focusing it says
    // which conversation this is.
    if (document.activeElement !== document.body) return;
    section.current?.focus();
  }, [finished]);

  const readOnly = conversation.readOnly ?? false;
  const heading = readOnly
    ? conversation.reference === null
      ? t('chat.conversation.listening', { role: roleName })
      : t('chat.conversation.listeningWithReference', {
          role: roleName,
          reference: conversation.reference,
        })
    : conversation.reference === null
      ? t('chat.conversation.label', { role: roleName })
      : t('chat.conversation.labelWithReference', {
          role: roleName,
          reference: conversation.reference,
        });

  return (
    <section
      className="chat-conversation"
      aria-labelledby={headingId}
      tabIndex={-1}
      ref={(element) => {
        section.current = element;
        sectionRef(element);
      }}
    >
      <h3 id={headingId} className="chat-conversation__heading">
        {heading}
      </h3>
      {/*
        Gone once the agent is terminal: there is nothing left to complete,
        whether it ended here or failed mid-turn on its own.

        Its own accessible name naming the role, not a bare "Complete": every
        open panel has one of these buttons, and several identically-named
        controls on one screen fail WCAG 2.4.6.
      */}
      {!finished && !readOnly && (
        <Button
          className="react-aria-Button chat-conversation__complete"
          // Disabled rather than queued: a turn is in flight, and completing
          // the chat out from under it is a real race the server refuses too.
          isDisabled={status === 'running' || complete.isPending}
          onPress={() => {
            complete.mutate();
          }}
        >
          {t('chat.complete', { role: roleName })}
        </Button>
      )}
      <Transcript agentId={agentId} roleName={roleName} />
      {/* Listening in is not a conversation: nothing to send. */}
      {!readOnly && (
        <MessageInput agentId={agentId} roleName={roleName} status={status} />
      )}
      {/*
        Its own announcer channel, not the `chat:` one the message form uses:
        two failures on one channel coalesce into a single phrase, and a failed
        completion and a failed send are different things to be told about.
      */}
      {complete.isError && (
        <ErrorState
          message={t('chat.complete.failed')}
          channel={`chat-complete:${agentId}`}
        />
      )}
    </section>
  );
};
