import { useEffect, useRef } from 'react';
import { Button } from 'react-aria-components';
import { ANNOUNCE_IMMEDIATE_MS, announce } from '../../announce/announcer';
import type { StringKey, StringParams } from '../../strings';
import { t } from '../../strings';

/** The announcer channel for changes made elsewhere to what is on screen. */
const CHANNEL = 'records-remote';

export interface OutOfDateNoticeProps {
  /** What changed, in words. */
  readonly message: string;
  /** Said once, when this notice first appears or its kind changes. */
  readonly announcement: StringKey;
  readonly announcementParams?: StringParams;
  /** Shows a Reload button; it moves focus somewhere stable itself. */
  readonly onReload?: () => void;
}

/**
 * Says that what is on screen has changed elsewhere (001.05), rather than
 * replacing it under the reader (ADR-027). One polite announcement when it
 * appears, and none for later changes: the notice's text keeps count, and a
 * reader who wants the detail can find it here.
 *
 * Like `SystemBanner`, it is a labelled group, not an alert, and it mounts no
 * live region of its own: the announcement goes through the one announcer.
 */
export const OutOfDateNotice = ({
  message,
  announcement,
  announcementParams,
  onReload,
}: OutOfDateNoticeProps) => {
  // Keyed on what is said, not on "have I run?": a table deleted after it
  // changed is worth a second announcement; more changes of the same kind
  // are not. StrictMode's second effect run finds the key already set.
  const announced = useRef<StringKey | null>(null);
  useEffect(() => {
    if (announced.current === announcement) return;
    announced.current = announcement;
    announce({
      channel: CHANNEL,
      change: announcement,
      params: announcementParams,
      throttleMs: ANNOUNCE_IMMEDIATE_MS,
    });
  }, [announcement, announcementParams]);

  return (
    <div
      className="out-of-date"
      role="group"
      aria-label={t('records.outOfDate.label')}
    >
      <p className="out-of-date__message">{message}</p>
      {onReload !== undefined && (
        <Button className="react-aria-Button" onPress={onReload}>
          {t('records.outOfDate.reload')}
        </Button>
      )}
    </div>
  );
};
