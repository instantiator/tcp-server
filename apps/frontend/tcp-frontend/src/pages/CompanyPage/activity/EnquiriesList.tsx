import { useState } from 'react';
import { Button } from 'react-aria-components';
import { useLiveCompanyEnquiriesList } from '../../../api/hooks';
import { ResponseDialog } from '../../../components/ResponseDialog/ResponseDialog';
import { t } from '../../../strings';
import { ActivityList } from './ActivityList';
import type { CountListener } from './activity-list-utils';

/** Conversations awaiting a person's reply. */
export interface EnquiriesListProps {
  readonly companyId: string;
  readonly onCount?: CountListener;
}

/**
 * Enquiries an agent is waiting on a person to answer. Each row opens the
 * response dialog (008.04) on its own conversation.
 *
 * **No announcement here.** `NewEnquiryNotifications` (rendered by
 * `CompanyTabs`, above the tab list) is now the single writer on the
 * `enquiry` announcer channel — `Notification` announces on arrival itself,
 * and a second writer here would coalesce one arriving enquiry into one
 * confusing phrase. The `removed`-case announcement this list used to make
 * (an enquiry leaving because it was answered) went with it: that is
 * background noise — it means someone else dealt with it — and the list's own
 * count and `aria-busy` still change to reflect it.
 */
export const EnquiriesList = ({ companyId, onCount }: EnquiriesListProps) => {
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const query = useLiveCompanyEnquiriesList(companyId, 'awaiting_user');
  // Filtered again here, client-side, in addition to the `?status=` query: a
  // live event patches a closed enquiry's status in place rather than
  // removing its row, so the query's own filter only describes what was true
  // when it was fetched.
  const rows = query.data?.filter(
    (conversation) => conversation.status === 'awaiting_user',
  );

  return (
    <>
      <ActivityList
        onCount={onCount}
        heading={t('activity.enquiries.heading')}
        query={query}
        channel="enquiry"
        count={rows?.length ?? 0}
        emptyHeading={t('activity.enquiries.empty.heading')}
        emptyBody={t('activity.enquiries.empty.body')}
      >
        <ul className="activity-list__rows">
          {rows?.map((conversation) => (
            <li className="activity-list__row" key={conversation.id}>
              <Button
                className="react-aria-Button activity-list__row-title"
                onPress={() => {
                  setOpenSlug(conversation.slug);
                }}
              >
                {t('activity.enquiries.open', { role: conversation.roleName })}
              </Button>
              <p className="activity-list__row-detail">
                {conversation.question}
              </p>
            </li>
          ))}
        </ul>
      </ActivityList>
      {openSlug !== null && (
        <ResponseDialog
          slug={openSlug}
          onClose={() => {
            setOpenSlug(null);
          }}
        />
      )}
    </>
  );
};
