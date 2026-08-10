import { useId } from 'react';
import { Button } from 'react-aria-components';
import { t } from '../../strings';
import { Transcript } from '../Transcript/Transcript';
import { MessageInput } from './MessageInput';
import type { Conversation } from './useChat';

export interface ChatConversationProps {
  readonly conversation: Conversation;
  /** Closes this conversation. `ChatDialog` decides where focus goes next. */
  readonly onClose: () => void;
  /**
   * Reports this panel's `<section>` element to `ChatDialog`, which keeps one
   * per conversation so it can move focus into any of them by agent id.
   * Called with `null` on unmount, same as any React ref callback.
   */
  readonly sectionRef: (element: HTMLElement | null) => void;
}

/**
 * One open conversation: its heading, a control to close it, its transcript
 * and its message form.
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
  onClose,
  sectionRef,
}: ChatConversationProps) => {
  // A fresh id per panel: several conversations render at once, and each
  // needs its own heading id to label its own section correctly.
  const headingId = useId();

  const heading =
    conversation.reference === null
      ? t('chat.conversation.label', { role: conversation.roleName })
      : t('chat.conversation.labelWithReference', {
          role: conversation.roleName,
          reference: conversation.reference,
        });

  return (
    <section
      className="chat-conversation"
      aria-labelledby={headingId}
      tabIndex={-1}
      ref={sectionRef}
    >
      <h3 id={headingId} className="chat-conversation__heading">
        {heading}
      </h3>
      {/*
        Its own accessible name naming the role, not a bare "Close": every
        open panel has one of these buttons, and several identically-named
        "Close" buttons on one screen fail WCAG 2.4.6.
      */}
      <Button
        className="react-aria-Button chat-conversation__close"
        onPress={onClose}
      >
        {t('chat.close', { role: conversation.roleName })}
      </Button>
      <Transcript
        agentId={conversation.agentId}
        roleName={conversation.roleName}
      />
      <MessageInput
        agentId={conversation.agentId}
        roleName={conversation.roleName}
      />
    </section>
  );
};
