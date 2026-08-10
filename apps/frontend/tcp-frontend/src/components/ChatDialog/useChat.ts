import { createContext, use } from 'react';

/** One open conversation in the chat dialog. */
export interface Conversation {
  /**
   * The agent holding the chat. Everything about a conversation keys on this:
   * its transcript, its event stream, its announcer channel and its dock entry.
   */
  readonly agentId: string;
  /** The agent's role, for the panel heading, the dock button and the announcements. */
  readonly roleName: string;
  /**
   * The chat assignment's shortcode, or `null` for a chat that has none.
   *
   * A brand new chat has none — `startChat` creates the agent and its
   * assignment together, and only the assignment list carries the shortcode.
   */
  readonly reference: string | null;
}

/** What a role needs to be talked to for the first time. */
export interface NewChat {
  readonly companyId: string;
  readonly roleId: string;
  /** Held only to name the conversation; the server does not return it. */
  readonly roleName: string;
}

/**
 * The two ways to reach the chat dialog.
 *
 * Deliberately small. A control that opens a chat needs to open a chat, and
 * nothing here reports on the dialog's own state — that belongs to the dialog.
 */
export interface ChatContextValue {
  /**
   * Opens a conversation with an agent that already exists, or brings an
   * already-open one to the fore. Restores the dialog if it is parked.
   */
  readonly openChat: (conversation: Conversation) => void;
  /**
   * Creates a chat-mode agent for a role, then opens it.
   *
   * The promise settles when the chat is open, or rejects with the `ApiError`
   * that stopped it. Pending and failure states are the caller's to show,
   * beside the control that was pressed — which is where an error about a
   * press belongs (ADR-027).
   */
  readonly startChat: (chat: NewChat) => Promise<void>;
}

/**
 * Held here rather than in `ChatProvider.tsx` so that file exports nothing but
 * its component — `react-refresh/only-export-components` is an error, and a
 * mixed module breaks fast refresh during development.
 */
export const ChatContext = createContext<ChatContextValue | null>(null);

/** Reaches the chat dialog. Throws outside a `ChatProvider`. */
export const useChat = (): ChatContextValue => {
  const value = use(ChatContext);
  if (value === null) {
    throw new Error('useChat must be used within a ChatProvider');
  }
  return value;
};
