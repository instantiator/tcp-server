import { useLiveAgentState } from '../../api/hooks';
import { statusLabel } from '../../api/statuses';
import { t } from '../../strings';

export interface ChatDockLabelProps {
  readonly agentId: string;
  readonly roleName: string;
}

/**
 * What a parked chat's dock button says: the role, and what its agent is doing.
 *
 * **This opens no event stream, and that is the point.** A minimised chat has
 * released its connection (see the connection budget beside `MAX_STREAMS`), so
 * the one thing a user still needs to know — has the reply arrived? — has to
 * come from somewhere already open. It comes from the query cache, which every
 * other live stream on the page is patching anyway. A parked chat costs
 * nothing and still tells the truth.
 *
 * It says only the role while the agent is unknown, rather than a placeholder
 * status: naming a state the browser has not been told about would be a guess
 * presented as a fact.
 */
export const ChatDockLabel = ({ agentId, roleName }: ChatDockLabelProps) => {
  const { data: agent } = useLiveAgentState({ agentId });

  if (agent === undefined || agent === null) return roleName;
  return t('chat.dock.label', {
    role: roleName,
    status: statusLabel(agent.status),
  });
};
