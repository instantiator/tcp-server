import { useEffect, useRef } from 'react';
import { Dialog } from '../Dialog/Dialog';
import { t } from '../../strings';
import { ChatConversation } from './ChatConversation';
import type { Conversation } from './useChat';
import './ChatDialog.css';

export interface ChatDialogProps {
  readonly conversations: readonly Conversation[];
  readonly isOpen: boolean;
  /** The conversation to move focus into once the dialog is showing, if any. */
  readonly focusAgentId: string | null;
  readonly onMinimise: () => void;
  readonly onCloseConversation: (agentId: string) => void;
  /** Called once focus has been moved, so the same move does not repeat. */
  readonly onFocused: () => void;
}

/**
 * The chat dialog: every open conversation, stacked in one modal.
 *
 * **Its own close control and escape both mean minimise, never close.** The
 * dialog already disappears on its own once `ChatProvider` empties the
 * conversation list — there is no separate "closed" state to keep in step
 * with that. So the one thing left for its close control and escape to mean
 * is "park this, I am not finished": a panel can be holding a half-typed
 * message, and throwing that away because of a stray escape press would be
 * hostile. Closing one specific conversation is `onCloseConversation`, wired
 * to each panel's own close button below — the dialog-level control never
 * calls it.
 *
 * **A plain vertical stack, not tabs.** React Aria's `Tabs` unmounts every
 * panel but the selected one, and every conversation here needs to keep
 * running while the dialog is showing: its own live transcript, subscribed
 * to its own event stream, receiving the agent's reply whether or not that
 * panel happens to be in view. Unmounting a hidden panel would drop its
 * stream and lose whatever arrived while another conversation had the focus.
 */
export const ChatDialog = ({
  conversations,
  isOpen,
  focusAgentId,
  onMinimise,
  onCloseConversation,
  onFocused,
}: ChatDialogProps) => {
  // Each open conversation's panel element, keyed by agent id, so focus can
  // be moved to one by id without a DOM query. Populated by the ref callback
  // handed down to each `ChatConversation` below.
  const panels = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    // A plain `useEffect`, not `useLayoutEffect` — deliberately. React
    // Aria's `Modal` focuses the first focusable element inside it in a
    // layout effect when it mounts. Layout effects all run, in order, before
    // any normal effect does, so this one is guaranteed to run after that
    // one and win the race for where focus ends up. A layout effect here
    // would run alongside (or even before) the modal's own, and the modal's
    // auto-focus could undo ours.
    if (focusAgentId === null || !isOpen) return;
    panels.current.get(focusAgentId)?.focus();
    onFocused();
  }, [focusAgentId, isOpen, onFocused]);

  const handleClose = (agentId: string): void => {
    const index = conversations.findIndex((c) => c.agentId === agentId);
    // ADR-027 names closing a chat a "destructive completion": focus must
    // land on a stable neighbour, never fall back to the page body. The next
    // conversation in the list is that neighbour, or the previous one if
    // this was the last.
    const neighbour = conversations[index + 1] ?? conversations[index - 1];

    onCloseConversation(agentId);

    if (neighbour !== undefined) {
      panels.current.get(neighbour.agentId)?.focus();
    }
    // No neighbour means this was the only open conversation: the dialog is
    // about to unmount, and React Aria returns focus to whatever opened it —
    // there is nothing left here to move focus to.
  };

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onMinimise();
      }}
      heading={t('chat.dialog.heading')}
      onMinimise={onMinimise}
    >
      {conversations.map((conversation) => (
        <ChatConversation
          key={conversation.agentId}
          conversation={conversation}
          onClose={() => {
            handleClose(conversation.agentId);
          }}
          sectionRef={(element) => {
            if (element === null) {
              panels.current.delete(conversation.agentId);
            } else {
              panels.current.set(conversation.agentId, element);
            }
          }}
        />
      ))}
    </Dialog>
  );
};
