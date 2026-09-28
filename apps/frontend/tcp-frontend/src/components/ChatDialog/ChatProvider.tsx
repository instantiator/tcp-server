import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useStartChat } from '../../api/hooks';
import { useDock } from '../Dialog/useDock';
import { ChatDialog } from './ChatDialog';
import { ChatDockLabel } from './ChatDockLabel';
import {
  ChatContext,
  type ChatContextValue,
  type Conversation,
  type NewChat,
} from './useChat';

/**
 * Holds the open conversations and renders the chat dialog around them.
 *
 * **The conversations live here rather than in the dialog because the dialog
 * unmounts.** Minimising takes the modal off the page entirely — a parked modal
 * would keep its focus trap and keep everything behind it inert — so anything
 * that must survive being parked has to be held above it. That is this
 * component, and it sits beside `DockProvider` in `AppShell` for the same
 * reason the dock does: a conversation belongs to the session, not to whichever
 * route happens to be showing. A dock entry whose `restore` pointed into an
 * unmounted page would be a button that does nothing.
 *
 * **Each conversation gets its own dock entry, not one for the whole dialog.**
 * Four parked chats are four buttons, each naming its own agent's status, and
 * restoring any of them brings the dialog back showing all of them with focus
 * in the one that was pressed.
 *
 * This component opens no event stream. Every stream in the chat dialog belongs
 * to a mounted `<Transcript/>`, and is released when that transcript unmounts.
 */
export const ChatProvider = ({ children }: { children: ReactNode }) => {
  const dock = useDock();
  const startChatMutation = useStartChat();

  const [conversations, setConversations] = useState<readonly Conversation[]>(
    [],
  );
  const [isOpen, setIsOpen] = useState(false);
  const [focusAgentId, setFocusAgentId] = useState<string | null>(null);

  // Which conversations are parked. A ref rather than state, because nothing
  // renders from it and it has to be readable from a `restore` callback the
  // dock has been holding since an earlier render.
  const dockedIds = useRef<readonly string[]>([]);

  const chat = useMemo<ChatContextValue>(() => {
    const openChat = (conversation: Conversation): void => {
      setConversations((previous) => {
        const index = previous.findIndex(
          (c) => c.agentId === conversation.agentId,
        );
        // Replaced in place rather than moved to the end. Panels must not
        // reorder under the user (ADR-027), and re-opening a conversation
        // already on screen is an ordinary thing to do.
        if (index === -1) return [...previous, conversation];
        const next = [...previous];
        // Listening in never takes the message field away from a chat that
        // already has one open: it stays read-only only if both are.
        const readOnly =
          (previous[index]?.readOnly ?? false) &&
          (conversation.readOnly ?? false);
        next[index] = { ...conversation, readOnly };
        return next;
      });

      // Every parked conversation comes back, because they all live in the one
      // dialog that is now on screen. `dock.remove` rather than `dock.restore`:
      // restoring each would run each one's callback, and they would fight over
      // which conversation gets the focus.
      for (const id of dockedIds.current) dock.remove(id);
      dockedIds.current = [];

      setIsOpen(true);
      setFocusAgentId(conversation.agentId);
    };

    const closeChat = (agentId: string): void => {
      const index = conversations.findIndex((c) => c.agentId === agentId);
      if (index === -1) return;

      const next = conversations.filter((c) => c.agentId !== agentId);
      setConversations(next);

      if (next.length === 0) {
        setIsOpen(false);
      } else {
        // The panel that takes the closed one's place: the conversation
        // after it, or the one before if this was the last panel.
        const neighbour = next[index] ?? next[index - 1];
        if (neighbour !== undefined) setFocusAgentId(neighbour.agentId);
      }

      // Defensive: a rendered panel's own Close button is only reachable
      // while its conversation is on screen, never while it is parked — but
      // this keeps the dock and `dockedIds` honest if that ever changes.
      dock.remove(agentId);
      dockedIds.current = dockedIds.current.filter((id) => id !== agentId);
    };

    return {
      openChat,
      closeChat,
      startChat: async ({ companyId, roleId, roleName }: NewChat) => {
        const agent = await startChatMutation.mutateAsync({
          companyId,
          roleId,
        });
        openChat({ agentId: agent.id, roleName, reference: null });
      },
    };
  }, [dock, startChatMutation, conversations]);

  const minimise = (): void => {
    for (const conversation of conversations) {
      dock.minimise({
        id: conversation.agentId,
        label: (
          <ChatDockLabel
            agentId={conversation.agentId}
            roleName={conversation.roleName}
          />
        ),
        restore: () => {
          chat.openChat(conversation);
        },
      });
    }
    dockedIds.current = conversations.map((c) => c.agentId);
    setIsOpen(false);

    // Focus has to land somewhere deliberate: the dialog it was in has just
    // been taken off the page (ADR-027). The first dock button is the nearest
    // stable thing to what the user was looking at.
    const first = conversations[0];
    if (first !== undefined) dock.focusEntry(first.agentId);
  };

  return (
    <ChatContext.Provider value={chat}>
      {children}
      {/*
        `closeChat` above is what removes a conversation from this list now —
        each panel's own Close button (`ChatConversation`), not the dialog's
        chrome. Completing a chat still leaves its panel showing; closing is
        the separate, explicit way to drop it once the user is done with it
        for this session. The chat itself is untouched on the server, so it
        stays reachable from Activity → Chats. The dialog's own chrome still
        has no close control of its own: escape and its one remaining chrome
        control (minimise) both mean minimise, for the same half-typed-message
        reason as before — only the per-panel Close is new.
      */}
      <ChatDialog
        conversations={conversations}
        isOpen={isOpen && conversations.length > 0}
        focusAgentId={focusAgentId}
        onMinimise={minimise}
        onFocused={() => {
          setFocusAgentId(null);
        }}
      />
    </ChatContext.Provider>
  );
};
