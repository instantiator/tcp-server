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

import type {
  PauseReason,
  TaskWaitKind,
  TaskWaiting,
} from '@tcp/shared/client';
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
 * consultations lists exist to draw attention to. `queued` counts as active
 * too — a start or resume job dispatched but waiting for a model slot has not
 * finished either.
 */
export const ACTIVE_AGENT_STATUSES = [
  'idle',
  'queued',
  'running',
  'paused',
] as const;

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
  queued: 'activity.status.queued',
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

/** The fields {@link agentStatusLabel} needs — a subset any `AgentDTO` satisfies. */
export interface AgentStatusFields {
  readonly status: string;
  readonly pauseReason?: string | null;
  /** ISO-8601. Absent or `null` both mean "no scheduled retry". */
  readonly resumeAfter?: string | null;
}

/** Local time only — this labels a fixed moment, not a running clock. */
const nextTryFormatter = new Intl.DateTimeFormat(undefined, {
  timeStyle: 'short',
});

/** The words for each non-rate-limited pause reason. A new reason fails typecheck here. */
const PAUSE_KEYS: Record<Exclude<PauseReason, 'rate_limited'>, StringKey> = {
  user_input: 'agent.pause.user_input',
  consultation: 'agent.pause.consultation',
  shutdown: 'agent.pause.shutdown',
  spend_cap: 'agent.pause.spend_cap',
  manual: 'agent.pause.manual',
};

/** The rate-limited wording, shared by the agent and task labels. */
const rateLimitedLabel = (resumeAfter: string | null | undefined): string =>
  typeof resumeAfter === 'string'
    ? t('activity.status.rateLimited', {
        time: nextTryFormatter.format(new Date(resumeAfter)),
      })
    : t('activity.status.rateLimited.manual');

/**
 * The user's word for an agent's status, saying why a paused agent is paused
 * (and, for a rate limit, when it is next tried) — `statusLabel` alone would
 * just say "Paused" and drop the one thing worth knowing.
 *
 * Takes the whole agent rather than a bare status string, because the extra
 * wording depends on `pauseReason` and `resumeAfter` too.
 */
export const agentStatusLabel = (agent: AgentStatusFields): string => {
  if (agent.status !== 'paused') return statusLabel(agent.status);
  const reason = agent.pauseReason;
  if (reason === 'rate_limited') return rateLimitedLabel(agent.resumeAfter);
  if (reason && Object.hasOwn(PAUSE_KEYS, reason)) {
    return t(PAUSE_KEYS[reason as keyof typeof PAUSE_KEYS]);
  }
  return statusLabel(agent.status);
};

/** The sentence for each {@link TaskWaitKind}. A new kind fails typecheck here. */
const WAITING_KEYS: Record<
  Exclude<TaskWaitKind, 'manual' | 'rate_limited'>,
  StringKey
> = {
  spend_cap: 'task.waiting.spend_cap',
  shutdown: 'task.waiting.shutdown',
  user_input: 'task.waiting.user_input',
  consultation: 'task.waiting.consultation',
  queued: 'task.waiting.queued',
};

/** The user's sentence for why a task is standing still, and what to do about it. */
export const taskWaitingLabel = (waiting: TaskWaiting): string => {
  switch (waiting.kind) {
    case 'manual':
      return waiting.pausedBy
        ? t('task.waiting.manual', { name: waiting.pausedBy })
        : t('task.waiting.manualAnonymous');
    case 'rate_limited':
      return rateLimitedLabel(waiting.resumeAfter);
    default:
      return t(WAITING_KEYS[waiting.kind]);
  }
};
