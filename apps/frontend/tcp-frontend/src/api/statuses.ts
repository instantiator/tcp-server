/**
 * The statuses that mean "still happening", per entity, and the user's word for
 * each one.
 *
 * Each list is the complement of that entity's terminal statuses, and exists
 * because the browser has to do this filtering itself. A live event patches a
 * cached row's status **in place**, so a task that succeeds stays in a list
 * fetched with `?status=ready` and a closed enquiry stays in one fetched with
 * `?status=awaiting_user` — the row is corrected, not removed. What a user sees
 * is therefore whatever the rendering filters, never whatever the query asked
 * for.
 *
 * Written as literals rather than derived from the generated schema: the schema
 * enumerates every status, and there is nothing in it that says which ones are
 * over. That is a product judgement, and it belongs somewhere a person reads.
 */

import { t, type StringKey } from '../strings';

/** Non-terminal {@link TcpTaskStatus} values — a task still being worked. */
export const ACTIVE_TASK_STATUSES = [
  'ready',
  'planning',
  'in-progress',
  'finalising',
] as const;

/**
 * Non-terminal `AgentStatus` values.
 *
 * `paused` counts as active: an agent waiting on a person or on another agent
 * has not finished, and hiding it would hide the very thing the enquiries and
 * consultations lists exist to draw attention to.
 */
export const ACTIVE_AGENT_STATUSES = ['idle', 'running', 'paused'] as const;

/** Non-terminal {@link TcpAssignmentStatus} values. */
export const ACTIVE_ASSIGNMENT_STATUSES = [
  'ready',
  'in-progress',
  'in-qa',
] as const;

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

/**
 * The user's word for a status, falling back rather than printing a schema
 * value.
 *
 * Here rather than beside the activity lists that first needed it: the chat
 * dialog's dock button names its agent's status too, and a shared component
 * must not reach into a page's own directory for it.
 */
export const statusLabel = (status: string): string => {
  const key = STATUS_KEYS[status];
  return key === undefined ? t('activity.status.unknown') : t(key);
};
