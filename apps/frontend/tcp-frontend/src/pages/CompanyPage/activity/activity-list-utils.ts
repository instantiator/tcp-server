import { t, type StringKey } from '../../../strings';

/**
 * Shared types and helpers for the four activity lists.
 *
 * Each list is thin on purpose: call its hook, filter to the rows worth
 * showing, announce what changed, and hand the rows to `ActivityList`, which
 * owns loading, error and empty presentation for all four. This module holds
 * what more than one of them needs.
 */

/** Props shared by the three lists that show a role name. */
export interface ListProps {
  readonly companyId: string;
  /** Role id to display name. Agent and assignment rows carry only a `roleId`. */
  readonly roleNames: ReadonlyMap<string, string>;
}

// Every status a task, agent or assignment row can carry, mapped to its
// string key. A `Record` lookup rather than a template-literal key: the
// latter would type as `string`, not `StringKey`, and require a cast to pass
// to `t` — this stays honest under `strict` with none.
const STATUS_KEYS: Record<string, StringKey> = {
  ready: 'activity.status.ready',
  planning: 'activity.status.planning',
  'in-progress': 'activity.status.in-progress',
  finalising: 'activity.status.finalising',
  succeeded: 'activity.status.succeeded',
  failed: 'activity.status.failed',
  cancelled: 'activity.status.cancelled',
  idle: 'activity.status.idle',
  running: 'activity.status.running',
  paused: 'activity.status.paused',
  completed: 'activity.status.completed',
  'in-qa': 'activity.status.in-qa',
};

/** The user's word for a status, falling back rather than printing a schema value. */
export const statusLabel = (status: string): string => {
  const key = STATUS_KEYS[status];
  return key === undefined ? t('activity.status.unknown') : t(key);
};

/** A role's display name. Agent and assignment rows carry only a `roleId`. */
export const roleLabel = (
  roleNames: ReadonlyMap<string, string>,
  roleId: string,
): string => roleNames.get(roleId) ?? t('activity.role.unknown');
