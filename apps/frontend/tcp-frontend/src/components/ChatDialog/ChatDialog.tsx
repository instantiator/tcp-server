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
  /** Called once focus has been moved, so the same move does not repeat. */
  readonly onFocused: () => void;
}

/**
 * The chat dialog: every open conversation, stacked in one modal.
 *
 * **It has no close control of its own — only minimise (`hideClose`).** The
 * dialog already disappears on its own once `ChatProvider` empties the
 * conversation list, so there is no separate "closed" state for a close button
 * to reach: it would do exactly what minimise does, under a name suggesting
 * otherwise. Escape is still wired to minimise, because a panel can be holding
 * a half-typed message and throwing that away on a stray press would be
 * hostile.
 *
 * **This component never shortens its own list.** Completing a conversation
 * (`ChatConversation`) leaves its panel in place with its transcript intact,
 * so no focus has to be rehomed to a neighbour. Closing one does shorten the
 * list — but that happens in `ChatProvider`, which owns `conversations` and
 * decides where focus goes next; this component only renders whatever it is
 * handed and moves focus to `focusAgentId` when told to. The focus machinery
 * below serves both directions: bringing a conversation back from the dock,
 * and landing on the neighbour of one that was just closed.
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

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onMinimise();
      }}
      heading={t('chat.dialog.heading')}
      onMinimise={onMinimise}
      hideClose
    >
      {conversations.map((conversation) => (
        <ChatConversation
          key={conversation.agentId}
          conversation={conversation}
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
