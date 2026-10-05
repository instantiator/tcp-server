import { useEffect, useRef, useState } from 'react';
import { useLiveNotifications } from '../../../api/hooks';
import { Notification } from '../../../components/Notification/Notification';
import { t } from '../../../strings';

export interface NewNotificationToastsProps {
  readonly companyId: string;
}

/** One arrived-and-not-yet-dismissed notification, enough to render its toast. */
interface ArrivedNotification {
  readonly id: string;
  readonly message: string;
  readonly severity: 'info' | 'warning' | 'error';
}

/**
 * Tells a user about a notification that arrived while they were not looking
 * at the Notifications tab (000.02).
 *
 * Modelled line-for-line on `NewEnquiryNotifications`: value-diffed against
 * the ids seen last pass (never a "have I run?" boolean — `StrictMode`
 * invokes this effect twice on mount with the same `query.data`, and a
 * boolean flag would be spent by the first invocation), first load is not an
 * arrival, and a toast is dropped once its row leaves the list — here, once
 * it is dismissed, since `useLiveNotifications` already filters to active
 * rows.
 *
 * **Error-severity arrivals interrupt (`assertive`); everything else waits
 * its turn (`polite`)** — ADR-027's toast row ("polite, assertive on
 * failure"). `Notification` already takes a `politeness` prop for exactly
 * this, so no change to that component was needed.
 */
export const NewNotificationToasts = ({
  companyId,
}: NewNotificationToastsProps) => {
  const query = useLiveNotifications();

  const [arrived, setArrived] = useState<readonly ArrivedNotification[]>([]);

  const seenIds = useRef<ReadonlySet<string> | null>(null);

  useEffect(() => {
    // Re-filtered here, exactly as `useLiveNotifications`'s callers do: a
    // live dismissal patches a row's `dismissedAt` in place rather than
    // removing it, so the query's own filter only describes what was true
    // when it was fetched.
    const current = query.data?.filter((row) => row.dismissedAt === undefined);
    // Still loading, or failed: there is no membership to diff.
    if (current === undefined) return;

    const currentIds = new Set(current.map((row) => row.id));

    if (seenIds.current === null) {
      // First load: what's already there is not an arrival.
      seenIds.current = currentIds;
      return;
    }

    const before = seenIds.current;
    seenIds.current = currentIds;

    const newlyArrived = current
      .filter((row) => !before.has(row.id))
      .map((row) => ({
        id: row.id,
        message: row.message,
        severity: row.severity,
      }));

    // Also drops any toast for an id that has left the list — dismissed from
    // the Notifications tab, `tcp-cli`, or another tab.
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
          message={entry.message}
          durableHref={`/company/${companyId}#notifications`}
          durableLabel={t('notifications.toast.link')}
          channel="notification"
          politeness={entry.severity === 'error' ? 'assertive' : 'polite'}
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
