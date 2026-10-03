import { t } from '../../../strings';

/**
 * Shared types and helpers for the activity lists.
 *
 * Each list is thin on purpose: call its hook, filter to the rows worth
 * showing, announce what changed, and hand the rows to `ActivityList`, which
 * owns loading, error and empty presentation for all of them. This module holds
 * what more than one of them needs.
 *
 * `statusLabel` used to live here and now lives in `src/api/statuses.ts`, with
 * the rest of the status judgements — the chat dialog needs it too, and a
 * shared component must not import from a page's own directory.
 */

/**
 * Receives a list's shown count, or `null` while it has no answer (loading
 * or failed). Must be stable across renders: it is an effect dependency.
 */
export type CountListener = (count: number | null) => void;

/** Props shared by the lists that show a role name. */
export interface ListProps {
  readonly companyId: string;
  /** Role id to display name. Agent and assignment rows carry only a `roleId`. */
  readonly roleNames: ReadonlyMap<string, string>;
  /** Told how many rows the list shows, for its tab's badge. */
  readonly onCount?: CountListener;
}

/** A role's display name. Agent and assignment rows carry only a `roleId`. */
export const roleLabel = (
  roleNames: ReadonlyMap<string, string>,
  roleId: string,
): string => roleNames.get(roleId) ?? t('activity.role.unknown');
