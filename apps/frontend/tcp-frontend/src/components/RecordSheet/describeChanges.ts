import type { RowChanges } from '../../api/hooks';
import type { CountKey } from '../../strings';
import { tCount } from '../../strings';

/** The words for each kind of change, so a search can say "no longer match". */
export interface ChangeWords {
  readonly changed: CountKey;
  readonly deleted: CountKey;
  readonly added: CountKey;
}

/** How a table's sheet words its changes. */
export const TABLE_WORDS: ChangeWords = {
  changed: 'records.outOfDate.changed',
  deleted: 'records.outOfDate.deleted',
  added: 'records.outOfDate.added',
};

/** "2 rows changed, 1 row added": only the kinds of change there are. */
export const describeChanges = (
  changes: RowChanges,
  words: ChangeWords = TABLE_WORDS,
): string =>
  [
    [words.changed, changes.changed.size] as const,
    [words.deleted, changes.deleted.size] as const,
    [words.added, changes.added] as const,
  ]
    .filter(([, count]) => count > 0)
    .map(([key, count]) => tCount(key, count))
    .join(', ');
