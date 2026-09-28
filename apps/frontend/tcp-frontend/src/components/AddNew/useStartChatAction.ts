import { useState } from 'react';
import { ANNOUNCE_IMMEDIATE_MS, announce } from '../../announce/announcer';
import { ApiError } from '../../api/errors';
import { useChat } from '../ChatDialog/useChat';

/** The part of a role this action needs — id to send, name to announce. */
export interface StartChatRole {
  readonly id: string;
  readonly name: string;
}

export interface UseStartChatActionOptions {
  /** Called once a chat has started — the caller's cue to close its menu. */
  readonly onStarted?: () => void;
}

export interface StartChatAction {
  /** Starts a chat with `role`. A second call while one is pending is ignored. */
  readonly start: (role: StartChatRole) => void;
  /** The role a chat is being started for, or `null` when none is in flight. */
  readonly pendingRoleId: string | null;
  /** The error from the last failed attempt, until {@link StartChatAction.clearError} clears it. */
  readonly error: ApiError | Error | null;
  readonly clearError: () => void;
}

/**
 * Starts a chat-mode agent for a role and opens it, for the "New chat"
 * submenu (`AddNewMenu`).
 *
 * `useChat().startChat` already does the work and reports its own pending and
 * failure states as the caller's to show (see `useChat.ts`) — this hook is
 * that caller: it tracks which role is in flight, announces a failure
 * assertively on its own channel. The announcement still fires if the menu
 * that owns it has unmounted meanwhile, which is why there is no mounted guard.
 */
export const useStartChatAction = (
  companyId: string,
  { onStarted }: UseStartChatActionOptions = {},
): StartChatAction => {
  const { startChat } = useChat();
  const [pendingRoleId, setPendingRoleId] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);

  const start = (role: StartChatRole): void => {
    if (pendingRoleId !== null) return;

    setError(null);
    setPendingRoleId(role.id);

    startChat({ companyId, roleId: role.id, roleName: role.name })
      .then(() => {
        setPendingRoleId(null);
        onStarted?.();
      })
      .catch((caught: unknown) => {
        const asError =
          caught instanceof Error ? caught : new Error(String(caught));
        setPendingRoleId(null);
        setError(asError);
        announce({
          channel: 'add-new',
          change: 'addNew.error',
          params: { role: role.name },
          politeness: 'assertive',
          throttleMs: ANNOUNCE_IMMEDIATE_MS,
        });
      });
  };

  const clearError = (): void => {
    setError(null);
  };

  return { start, pendingRoleId, error, clearError };
};
