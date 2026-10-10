import { useEffect, useRef } from 'react';
import { t } from '../../strings';
import { Dialog } from '../Dialog/Dialog';
import { EmptyState } from '../EmptyState/EmptyState';
import { ChatList } from './ChatList';
import { ChatView } from './ChatView';
import type { Eavesdrop } from './eavesdropStorage';
import type { Conversation } from './useChat';
import './ChatDialog.css';

export interface ChatDialogProps {
  readonly isOpen: boolean;
  /** The company whose chats are listed; `null` before any company was seen. */
  readonly companyId: string | null;
  readonly selected: Conversation | null;
  readonly eavesdrops: readonly Eavesdrop[];
  /** An opener asked for this view: move focus into it once showing. */
  readonly focusRequested: boolean;
  readonly onFocused: () => void;
  readonly onSelect: (conversation: Conversation) => void;
  readonly onArchiveEavesdrop: (agentId: string) => void;
  /** The selected view was archived or deleted. */
  readonly onDeselect: () => void;
  readonly onMinimise: () => void;
  readonly onClose: () => void;
}

/**
 * The chat dialog (000.06): a list of views on the left and the selected one
 * on the right, like a conventional chat client.
 *
 * Reading and tab order follows the layout: the title bar, then the list pane
 * (search, the grouped list, Show archived, Add new), then the selected view
 * (its heading and controls, the transcript, Follow, the message form). Below
 * 40rem wide the panes stack in the same order.
 *
 * It has both Minimise and Close. Closing loses nothing — role chats live on
 * the server, and the eavesdrop list and selection are held by `ChatProvider`
 * — so escape closes it, as it does every other dialog.
 */
export const ChatDialog = ({
  isOpen,
  companyId,
  selected,
  eavesdrops,
  focusRequested,
  onFocused,
  onSelect,
  onArchiveEavesdrop,
  onDeselect,
  onMinimise,
  onClose,
}: ChatDialogProps) => {
  const list = useRef<HTMLDivElement>(null);
  const view = useRef<HTMLElement>(null);

  useEffect(() => {
    // A plain effect, not a layout effect: React Aria's `Modal` focuses its
    // first focusable element in a layout effect on mount, and this has to
    // run after it to win.
    if (!focusRequested || !isOpen) return;
    (view.current ?? list.current)?.focus();
    onFocused();
  }, [focusRequested, isOpen, onFocused]);

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      heading={t('chat.dialog.heading')}
      onMinimise={onMinimise}
    >
      <div className="chat-dialog">
        {companyId !== null && (
          <ChatList
            companyId={companyId}
            selectedAgentId={selected?.agentId ?? null}
            eavesdrops={eavesdrops}
            onSelect={onSelect}
            listRef={list}
          />
        )}
        {selected === null ? (
          <div className="chat-dialog__empty">
            <EmptyState heading={t('chat.view.empty.heading')} headingLevel={3}>
              {t('chat.view.empty.body')}
            </EmptyState>
          </div>
        ) : (
          <ChatView
            // A fresh view per agent: its transcript and stream start clean.
            key={selected.agentId}
            conversation={selected}
            sectionRef={view}
            onArchiveEavesdrop={onArchiveEavesdrop}
            onGone={() => {
              onDeselect();
              list.current?.focus();
            }}
          />
        )}
      </div>
    </Dialog>
  );
};
