import { useCallback } from 'react';
import {
  useCompanyRolesList,
  useLiveAssignmentsList,
} from '../../../../api/hooks';
import { useChat } from '../../../../components/ChatDialog/useChat';
import { t } from '../../../../strings';

/** The agent fields listening in needs. */
export interface ListenInAgent {
  readonly id: string;
  readonly roleId: string;
  readonly assignmentId: string | null;
}

/**
 * Opens an agent's chat read-only — "listening in" — named for its role and
 * labelled with its assignment's shortcode. Shared by the tray's "Listen in"
 * button and the canvas's thought bubble (005.01), so both open exactly the
 * same conversation. Roles and assignments come from the cache the office
 * view already reads, so this costs no extra request.
 */
export const useListenIn = (
  companyId: string,
): ((agent: ListenInAgent) => void) => {
  const { openChat } = useChat();
  const { data: roles } = useCompanyRolesList(companyId);
  const { data: assignments } = useLiveAssignmentsList({ companyId });

  return useCallback(
    (agent: ListenInAgent) => {
      openChat({
        agentId: agent.id,
        roleName:
          roles?.find((role) => role.id === agent.roleId)?.name ??
          t('activity.role.unknown'),
        reference:
          assignments?.find((row) => row.id === agent.assignmentId)
            ?.shortcode ?? null,
        readOnly: true,
      });
    },
    [openChat, roles, assignments],
  );
};
