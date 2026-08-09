/**
 * The statuses that mean "still happening", per entity.
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
