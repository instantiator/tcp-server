import { useState } from 'react';
import { Button } from 'react-aria-components';
import { Link } from 'react-router';
import { ANNOUNCE_IMMEDIATE_MS, announce } from '../../../announce/announcer';
import {
  useDismissNotification,
  useLiveNotifications,
  useResumeCompany,
} from '../../../api/hooks';
import { ButtonRow } from '../../../components/ButtonRow/ButtonRow';
import { ErrorState } from '../../../components/ErrorState/ErrorState';
import { t, tCount } from '../../../strings';
import { ActivityList } from './ActivityList';
import type { CountListener } from './activity-list-utils';
import { useFocusLinkedRow } from './useFocusLinkedRow';

export interface NotificationsListProps {
  readonly companyId: string;
  readonly onCount?: CountListener;
}

/** Severity shown as text, never colour alone (WCAG 1.4.1). */
const SEVERITY_LABEL = {
  info: 'notifications.severity.info',
  warning: 'notifications.severity.warning',
  error: 'notifications.severity.error',
} as const;

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/**
 * The company's notifications and the application-wide ones: spend thresholds,
 * caps reached, resets and untracked providers (000.02), and a task's failing
 * or pausing. A row about a task links to that task's dialog. One Dismiss button per row, and
 * `spend_reached` rows also offer "Resume this company's paused work" —
 * every other kind carries no action here, by design (only an administrator
 * may lift a cap, and this client has no admin flag to gate that button on).
 *
 * Newest first, same order the server sends — never re-sorted client-side,
 * per ADR-027's "live updates never reorder the list".
 */
export const NotificationsList = ({
  companyId,
  onCount,
}: NotificationsListProps) => {
  const query = useLiveNotifications(companyId);
  // Re-filtered here, client-side, for the same reason `EnquiriesList` does:
  // a live dismissal patches the row's `dismissedAt` in place rather than
  // removing it from the array, so the query's own "active only" filter only
  // describes what was true when it was fetched.
  const rows = query.data?.filter((row) => row.dismissedAt === undefined);

  // `?notification=<id>`, from a toast's link: focus and mark that row.
  const { linkedId, rowRef } = useFocusLinkedRow(
    'notification',
    rows?.map((row) => row.id),
  );

  const dismiss = useDismissNotification();
  const resumeCompany = useResumeCompany(companyId);
  // Which row's Resume button was last pressed, so its outcome (the count, or
  // the failure) is shown on that row rather than on every `spend_reached`
  // row at once.
  const [resumedId, setResumedId] = useState<string | null>(null);
  const [resumedCount, setResumedCount] = useState<number | null>(null);

  const handleResume = (notificationId: string): void => {
    setResumedId(notificationId);
    setResumedCount(null);
    resumeCompany.mutate(undefined, {
      onSuccess: (result) => {
        setResumedCount(result.resumed);
        announce({
          channel: 'notifications',
          change: 'notifications.resumeCompany.announced',
          throttleMs: ANNOUNCE_IMMEDIATE_MS,
        });
      },
    });
  };

  return (
    <ActivityList
      onCount={onCount}
      heading={t('notifications.heading')}
      query={query}
      channel="notifications"
      count={rows?.length ?? 0}
      emptyHeading={t('notifications.empty.heading')}
      emptyBody={t('notifications.empty.body')}
    >
      <ul className="activity-list__rows">
        {rows?.map((row) => (
          <li
            className="activity-list__row"
            key={row.id}
            ref={row.id === linkedId ? rowRef : undefined}
            tabIndex={-1}
            aria-current={row.id === linkedId ? 'true' : undefined}
          >
            <p className="activity-list__row-title">
              {t(SEVERITY_LABEL[row.severity])}
            </p>
            {/* Describes this row's buttons, so a list of buttons still says which notification each acts on. */}
            <p
              className="activity-list__row-detail"
              id={`notification-${row.id}-message`}
            >
              {row.message}
            </p>
            <p className="activity-list__row-detail">
              {dateFormatter.format(new Date(row.createdAt))}
            </p>
            <ButtonRow>
              <Button
                className="react-aria-Button"
                aria-describedby={`notification-${row.id}-message`}
                onPress={() => {
                  dismiss.mutate(row.id);
                }}
              >
                {t('notifications.dismiss')}
              </Button>
              {row.taskId != null && (
                <Link
                  to={`/company/${companyId}?task=${row.taskId}#tasks`}
                  aria-describedby={`notification-${row.id}-message`}
                >
                  {t('notifications.openTask')}
                </Link>
              )}
              {row.kind === 'spend_reached' && (
                <Button
                  className="react-aria-Button"
                  aria-describedby={`notification-${row.id}-message`}
                  isDisabled={resumeCompany.isPending && resumedId === row.id}
                  onPress={() => {
                    handleResume(row.id);
                  }}
                >
                  {t('notifications.resumeCompany')}
                </Button>
              )}
            </ButtonRow>
            {resumedId === row.id && resumedCount !== null && (
              <p className="activity-list__row-detail">
                {tCount('notifications.resumeCompany.requested', resumedCount)}
              </p>
            )}
            {resumedId === row.id && resumeCompany.isError && (
              <ErrorState
                message={t('notifications.resumeCompany.failed')}
                channel="notifications-resume"
              />
            )}
          </li>
        ))}
      </ul>
    </ActivityList>
  );
};
