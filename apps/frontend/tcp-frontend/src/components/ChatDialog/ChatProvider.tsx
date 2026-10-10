import { useMemo, useState, type ReactNode } from 'react';
import { useMatch } from 'react-router';
import { useStartChat } from '../../api/hooks';
import { useSession } from '../../auth/useSession';
import { t } from '../../strings';
import { useDock } from '../Dialog/useDock';
import { ChatDialog } from './ChatDialog';
import {
  eavesdropStorageKey,
  readEavesdrops,
  writeEavesdrops,
  type Eavesdrop,
} from './eavesdropStorage';
import {
  ChatContext,
  type ChatContextValue,
  type Conversation,
  type NewChat,
} from './useChat';

/** The chat dialog's one dock entry. */
const DOCK_ID = 'chats';

/** The eavesdrop list, and the storage key it was read from. */
interface StoredEavesdrops {
  readonly key: string | null;
  readonly list: readonly Eavesdrop[];
}

/**
 * Holds the chat dialog's state and renders the dialog.
 *
 * **State lives here because the dialog unmounts** when minimised (a parked
 * modal would keep its focus trap), and because a chat belongs to the session,
 * not to whichever route is showing — this sits beside `DockProvider` in
 * `AppShell` for that reason.
 *
 * It holds the selected view, whether the dialog is showing, and the list of
 * agents being listened in on (kept in browser storage per user and company,
 * see `eavesdropStorage.ts`). Role chats come from the server, so they aren't
 * held here at all.
 *
 * The company is the current route's, or the last one seen: the dialog
 * outlives the company page it was opened from.
 *
 * This component opens no event stream. The dialog's one stream belongs to the
 * selected view's `<Transcript/>`.
 */
export const ChatProvider = ({ children }: { children: ReactNode }) => {
  const dock = useDock();
  const startChatMutation = useStartChat();
  const userId = useSession()?.userId;

  const routeCompanyId = useMatch('/company/:companyId/*')?.params.companyId;
  const [companyId, setCompanyId] = useState(routeCompanyId ?? null);
  if (routeCompanyId !== undefined && routeCompanyId !== companyId) {
    setCompanyId(routeCompanyId);
  }

  // Re-read whenever the user or company changes: each has its own list.
  // Without a session (tests, mostly) the list lives in memory only.
  const storageKey =
    userId === undefined || companyId === null
      ? null
      : eavesdropStorageKey(userId, companyId);
  const [eavesdrops, setEavesdrops] = useState<StoredEavesdrops>(() => ({
    key: storageKey,
    list: storageKey === null ? [] : readEavesdrops(storageKey),
  }));
  if (eavesdrops.key !== storageKey) {
    setEavesdrops({
      key: storageKey,
      list: storageKey === null ? [] : readEavesdrops(storageKey),
    });
  }

  const updateEavesdrops = (
    change: (list: readonly Eavesdrop[]) => readonly Eavesdrop[],
  ): void => {
    setEavesdrops((previous) => {
      const list = change(previous.list);
      if (previous.key !== null) writeEavesdrops(previous.key, list);
      return { key: previous.key, list };
    });
  };

  const [selected, setSelected] = useState<Conversation | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  // Set by an opener, so focus moves into the view it asked for.
  const [focusRequested, setFocusRequested] = useState(false);

  const select = (conversation: Conversation): void => {
    setSelected(conversation);
    if (conversation.readOnly !== true) return;
    // Listening in: join the list, or come back out of the archive.
    const entry: Eavesdrop = {
      agentId: conversation.agentId,
      roleName: conversation.roleName,
      reference: conversation.reference,
      archived: false,
    };
    updateEavesdrops((list) =>
      list.some((e) => e.agentId === entry.agentId)
        ? list.map((e) =>
            e.agentId === entry.agentId ? { ...e, archived: false } : e,
          )
        : [...list, entry],
    );
  };

  const chat = useMemo<ChatContextValue>(() => {
    const openChat = (conversation: Conversation): void => {
      select(conversation);
      dock.remove(DOCK_ID);
      setIsOpen(true);
      setFocusRequested(true);
    };
    return {
      openChat,
      startChat: async ({ companyId: company, roleId, roleName }: NewChat) => {
        const agent = await startChatMutation.mutateAsync({
          companyId: company,
          roleId,
        });
        openChat({ agentId: agent.id, roleName, reference: null });
      },
    };
    // `select` closes over setters only, which are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dock, startChatMutation]);

  const minimise = (): void => {
    dock.minimise({
      id: DOCK_ID,
      label: t('chat.dialog.heading'),
      restore: () => {
        setIsOpen(true);
      },
    });
    setIsOpen(false);
    // Focus has to land somewhere deliberate once the dialog is gone
    // (ADR-027): the button that now stands for it.
    dock.focusEntry(DOCK_ID);
  };

  return (
    <ChatContext.Provider value={chat}>
      {children}
      <ChatDialog
        isOpen={isOpen}
        companyId={companyId}
        selected={selected}
        eavesdrops={eavesdrops.list}
        focusRequested={focusRequested}
        onFocused={() => {
          setFocusRequested(false);
        }}
        onSelect={select}
        onArchiveEavesdrop={(agentId) => {
          updateEavesdrops((list) =>
            list.map((e) =>
              e.agentId === agentId ? { ...e, archived: true } : e,
            ),
          );
        }}
        onDeselect={() => {
          setSelected(null);
        }}
        onMinimise={minimise}
        onClose={() => {
          setIsOpen(false);
        }}
      />
    </ChatContext.Provider>
  );
};
