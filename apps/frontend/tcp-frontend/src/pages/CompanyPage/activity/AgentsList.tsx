import { useListChangeAnnouncement } from '../../../announce/useListChangeAnnouncement';
import { useLiveCompanyAgentsList } from '../../../api/hooks';
import { ACTIVE_AGENT_STATUSES, statusLabel } from '../../../api/statuses';
import { ExpandableText } from '../../../components/ExpandableText/ExpandableText';
import { t } from '../../../strings';
import { ActivityList } from './ActivityList';
import { roleLabel, type ListProps } from './activity-list-utils';

/**
 * Agents currently working. Rows are non-interactive — the MVP has no
 * assignment dialog for a row to open — apart from the prompt's own expander,
 * which acts on the row's text rather than opening anything.
 */
export const AgentsList = ({ companyId, roleNames, onCount }: ListProps) => {
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
      onCount={onCount}
      heading={t('activity.agents.heading')}
      query={query}
      channel="agents"
      count={rows?.length ?? 0}
      emptyHeading={t('activity.agents.empty.heading')}
      emptyBody={t('activity.agents.empty.body')}
    >
      <ul className="activity-list__rows">
        {rows?.map((agent) => {
          const role = roleLabel(roleNames, agent.roleId);
          return (
            // Keyed by agent id, which is what lets an expanded prompt survive
            // a live patch to this list.
            <li className="activity-list__row" key={agent.id}>
              <p className="activity-list__row-title">{role}</p>
              <p className="activity-list__row-detail">
                {statusLabel(agent.status)}
              </p>
              <ExpandableText
                text={agent.initialPrompt}
                expandLabel={t('activity.agents.prompt.expand', { role })}
                collapseLabel={t('activity.agents.prompt.collapse', { role })}
                className="activity-list__row-detail"
              />
            </li>
          );
        })}
      </ul>
    </ActivityList>
  );
};
