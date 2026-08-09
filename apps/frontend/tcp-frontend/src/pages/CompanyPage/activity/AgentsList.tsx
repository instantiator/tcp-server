import { useListChangeAnnouncement } from '../../../announce/useListChangeAnnouncement';
import { useLiveCompanyAgentsList } from '../../../api/hooks';
import { ACTIVE_AGENT_STATUSES } from '../../../api/statuses';
import { t } from '../../../strings';
import { ActivityList } from './ActivityList';
import { roleLabel, statusLabel, type ListProps } from './activity-list-utils';

/**
 * Agents currently working. Rows are non-interactive — the MVP has no
 * assignment dialog for a row to open — so each is plain text, not a link
 * or a button.
 */
export const AgentsList = ({ companyId, roleNames }: ListProps) => {
  const query = useLiveCompanyAgentsList(companyId);
  // `some` rather than `includes`, so the literal-union constant needs no
  // widening cast to be compared against the schema's `string`.
  const rows = query.data?.filter((agent) =>
    ACTIVE_AGENT_STATUSES.some((active) => active === agent.status),
  );

  useListChangeAnnouncement(
    rows?.map((agent) => agent.id),
    {
      channel: 'agents',
      added: 'announce.agentsStarted',
      removed: 'announce.agentsFinished',
    },
  );

  return (
    <ActivityList
      heading={t('activity.agents.heading')}
      query={query}
      channel="agents"
      count={rows?.length ?? 0}
      emptyHeading={t('activity.agents.empty.heading')}
      emptyBody={t('activity.agents.empty.body')}
    >
      <ul className="activity-list__rows">
        {rows?.map((agent) => (
          // Non-interactive: no assignment dialog exists in the MVP.
          <li className="activity-list__row" key={agent.id}>
            <p className="activity-list__row-title">
              {roleLabel(roleNames, agent.roleId)}
            </p>
            <p className="activity-list__row-detail">
              {statusLabel(agent.status)}
            </p>
            <p className="activity-list__row-detail">{agent.initialPrompt}</p>
          </li>
        ))}
      </ul>
    </ActivityList>
  );
};
