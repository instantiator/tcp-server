import { Button } from 'react-aria-components';
import { useListChangeAnnouncement } from '../../../announce/useListChangeAnnouncement';
import { useLiveCompanyChatsList } from '../../../api/hooks';
import { statusLabel } from '../../../api/statuses';
import { useChat } from '../../../components/ChatDialog/useChat';
import { t } from '../../../strings';
import { ActivityList } from './ActivityList';
import { roleLabel, type ListProps } from './activity-list-utils';

/**
 * Chats — assignments in `chat` mode. Unlike every other activity list, a
 * finished chat is still worth reading, so there is no status filter here.
 *
 * **Rows are interactive**, the one list in this view where that is true:
 * each opens the chat dialog on the agent it names. Every other list here has
 * no dialog yet to open.
 */
export const ChatsList = ({ companyId, roleNames }: ListProps) => {
  const query = useLiveCompanyChatsList(companyId);
  const { openChat } = useChat();

  // A chat assignment with no `agentId` has no agent to open — the two are
  // created together, so this is not expected to happen, but a row whose
  // button cannot do anything is worse than no row. Filtered before counting,
  // so the count shown and the rows rendered always agree.
  const rows = query.data?.filter(
    (assignment): assignment is typeof assignment & { agentId: string } =>
      assignment.agentId !== undefined,
  );

  useListChangeAnnouncement(
    rows?.map((assignment) => assignment.id),
    {
      channel: 'chats',
      added: 'announce.chatsStarted',
      removed: 'announce.chatsEnded',
    },
  );

  return (
    <ActivityList
      heading={t('activity.chats.heading')}
      query={query}
      channel="chats"
      count={rows?.length ?? 0}
      emptyHeading={t('activity.chats.empty.heading')}
      emptyBody={t('activity.chats.empty.body')}
    >
      <ul className="activity-list__rows">
        {rows?.map((assignment) => {
          const role = roleLabel(roleNames, assignment.roleId);
          return (
            <li className="activity-list__row" key={assignment.id}>
              {/*
                The button is the row's title, and its visible text is its
                whole accessible name — no `aria-label`. A `<button>` may only
                hold phrasing content, so the two-paragraph shape the other
                lists use cannot go inside one; and a name that says what
                pressing it does keeps every row in this list distinct from
                the plain role name the other lists show.
              */}
              <Button
                className="react-aria-Button activity-list__row-title"
                onPress={() => {
                  openChat({
                    agentId: assignment.agentId,
                    roleName: role,
                    reference: assignment.shortcode ?? null,
                  });
                }}
              >
                {t('activity.chats.open', { role })}
              </Button>
              <p className="activity-list__row-detail">
                {statusLabel(assignment.status)}
              </p>
            </li>
          );
        })}
      </ul>
    </ActivityList>
  );
};
