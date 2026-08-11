import { useEffect, useRef, useState } from 'react';
import { useLiveCompanyEnquiriesList } from '../../../api/hooks';
import { Notification } from '../../../components/Notification/Notification';
import { t } from '../../../strings';

export interface NewEnquiryNotificationsProps {
  readonly companyId: string;
}

/** One arrived-and-not-yet-dismissed enquiry, enough to render its notification. */
interface ArrivedEnquiry {
  readonly id: string;
  readonly roleName: string;
}

/**
 * Tells a user about a question that arrived while they were not looking at
 * the enquiries list.
 *
 * **The single writer on the `enquiry` announcer channel.** `EnquiriesList`
 * used to announce arrivals itself; that call was removed when this was
 * built, because `Notification` always announces on the channel it is given
 * (immediately, on appearance), and two writers on one channel would coalesce
 * one arriving enquiry into one confusing phrase rather than a clean one.
 *
 * **Reads the same query `EnquiriesList` does**
 * (`useLiveCompanyEnquiriesList(companyId, 'awaiting_user')`), so this costs
 * no request beyond the one the list already makes — both read the same
 * TanStack Query cache entry.
 */
export const NewEnquiryNotifications = ({
  companyId,
}: NewEnquiryNotificationsProps) => {
  const query = useLiveCompanyEnquiriesList(companyId, 'awaiting_user');

  const [arrived, setArrived] = useState<readonly ArrivedEnquiry[]>([]);

  // The ids seen as of the last pass, keyed by value rather than by a "have I
  // run?" boolean — `StrictMode` invokes this effect twice on mount with the
  // same `query.data`, and a boolean flag would be spent by the first
  // invocation, leaving the second to read the seed as nine arrivals. Diffing
  // the actual id set against itself finds nothing new either time.
  const seenIds = useRef<ReadonlySet<string> | null>(null);

  useEffect(() => {
    // Re-filtered here, exactly as `EnquiriesList` does and for the same
    // reason: a live event patches a closed enquiry's `status` in place
    // rather than removing its row, so the query's own `awaiting_user`
    // filter only describes what was true when it was fetched. Without this
    // the id stays in the set below, and a notification for a question
    // someone else has already answered would sit there until dismissed by
    // hand — which is the opposite of what the comment further down promises.
    const current = query.data?.filter(
      (conversation) => conversation.status === 'awaiting_user',
    );
    // Still loading, or failed: there is no membership to diff, and treating
    // "no data" as "everything left" would misreport a load failure.
    if (current === undefined) return;

    const currentIds = new Set(current.map((row) => row.id));

    if (seenIds.current === null) {
      // First load: what's already there is not an arrival, it's the page
      // loading — nothing to notify about.
      seenIds.current = currentIds;
      return;
    }

    const before = seenIds.current;
    seenIds.current = currentIds;

    const newlyArrived = current
      .filter((row) => !before.has(row.id))
      .map((row) => ({ id: row.id, roleName: row.roleName }));

    // Also drops any notification for an id that has left the list — someone
    // answered it, from `tcp-cli` or another tab, and there is nothing left
    // to act on here.
    setArrived((previous) => [
      ...previous.filter((entry) => currentIds.has(entry.id)),
      ...newlyArrived,
    ]);
  }, [query.data]);

  return (
    <>
      {arrived.map((entry) => (
        <Notification
          key={entry.id}
          message={t('activity.enquiries.notification', {
            role: entry.roleName,
          })}
          durableHref={`/company/${companyId}#enquiries`}
          durableLabel={t('activity.enquiries.notification.link')}
          channel="enquiry"
          onDismiss={() => {
            setArrived((previous) =>
              previous.filter((item) => item.id !== entry.id),
            );
          }}
        />
      ))}
    </>
  );
};
