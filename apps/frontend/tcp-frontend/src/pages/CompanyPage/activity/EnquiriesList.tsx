import { ANNOUNCE_IMMEDIATE_MS } from '../../../announce/announcer';
import { useListChangeAnnouncement } from '../../../announce/useListChangeAnnouncement';
import { useLiveCompanyEnquiriesList } from '../../../api/hooks';
import { t } from '../../../strings';
import { ActivityList } from './ActivityList';

/** Conversations awaiting a person's reply. */
export interface EnquiriesListProps {
  readonly companyId: string;
}

/**
 * Enquiries an agent is waiting on a person to answer. Rows are
 * non-interactive for now; 008.04 adds the user response dialog.
 */
export const EnquiriesList = ({ companyId }: EnquiriesListProps) => {
  const query = useLiveCompanyEnquiriesList(companyId, 'awaiting_user');
  // Filtered again here, client-side, in addition to the `?status=` query: a
  // live event patches a closed enquiry's status in place rather than
  // removing its row, so the query's own filter only describes what was true
  // when it was fetched.
  const rows = query.data?.filter(
    (conversation) => conversation.status === 'awaiting_user',
  );

  useListChangeAnnouncement(
    rows?.map((conversation) => conversation.id),
    {
      // Its own channel, spoken immediately: ADR-027 wants a new enquiry
      // announced individually, and a channel's interval is set by whichever
      // announcement opens its window — folding this into a shared list channel
      // would make a new enquiry wait behind ten seconds of that list's chatter.
      channel: 'enquiry',
      added: 'announce.enquiryNew',
      throttleMs: ANNOUNCE_IMMEDIATE_MS,
    },
  );

  return (
    <ActivityList
      heading={t('activity.enquiries.heading')}
      query={query}
      channel="enquiry"
      count={rows?.length ?? 0}
      emptyHeading={t('activity.enquiries.empty.heading')}
      emptyBody={t('activity.enquiries.empty.body')}
    >
      <ul className="activity-list__rows">
        {rows?.map((conversation) => (
          // Non-interactive for now; 008.04 adds the user response dialog.
          <li className="activity-list__row" key={conversation.id}>
            <p className="activity-list__row-title">{conversation.roleName}</p>
            <p className="activity-list__row-detail">{conversation.question}</p>
          </li>
        ))}
      </ul>
    </ActivityList>
  );
};
