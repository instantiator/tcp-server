import {
  ANNOUNCE_IMMEDIATE_MS,
  announce,
  type Announcement,
} from '../../announce/announcer';

/** The announcer channel for everything done to record tables. */
export const RECORDS_CHANNEL = 'records';

/** Says something happened straight away: these are the user's own actions. */
export const announceRecords = (
  change: Announcement['change'],
  params?: Announcement['params'],
): void =>
  announce({
    channel: RECORDS_CHANNEL,
    change,
    params,
    throttleMs: ANNOUNCE_IMMEDIATE_MS,
  });
