// Runtime-free: re-exported from `client.ts`, so type-only imports here.
import type { PauseReason } from '../models/TcpAgent.model';

/** Why a task is not moving: a pause reason, or waiting for a model slot. */
export type TaskWaitKind = PauseReason | 'queued';

/** What a task is waiting for, in the one shape the CLI and web both read. */
export interface TaskWaiting {
  kind: TaskWaitKind;
  /** Who paused it, for a manual pause. */
  pausedBy?: string;
  /** ISO-8601 time of the next automatic try, for a rate-limited pause. */
  resumeAfter?: string;
}

/** Agent pause reasons in the order the most actionable one wins. */
const REASON_PRECEDENCE: readonly PauseReason[] = [
  'rate_limited',
  'spend_cap',
  'shutdown',
  'manual',
  'user_input',
  'consultation',
];

const toIso = (value: string | Date): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

/**
 * Works out why a task is standing still, so every surface says the same
 * thing. A user's pause on the task beats anything its agents report; then the
 * agents' pauses win in {@link REASON_PRECEDENCE} order; then a queued agent
 * means the task is waiting for the model. Returns `null` when nothing is
 * holding it back.
 */
export function taskWaiting(
  task: { pausedAt?: string | Date | null; pausedBy?: string | null },
  agents: readonly {
    status: string;
    pauseReason?: PauseReason | null;
    resumeAfter?: string | Date | null;
  }[],
): TaskWaiting | null {
  if (task.pausedAt) {
    return task.pausedBy
      ? { kind: 'manual', pausedBy: task.pausedBy }
      : { kind: 'manual' };
  }
  const paused = agents.filter((a) => a.status === 'paused');
  for (const kind of REASON_PRECEDENCE) {
    const matching = paused.filter((a) => a.pauseReason === kind);
    if (matching.length === 0) continue;
    if (kind !== 'rate_limited') return { kind };
    const times = matching
      .flatMap((a) => (a.resumeAfter ? [toIso(a.resumeAfter)] : []))
      .sort();
    return times.length > 0 ? { kind, resumeAfter: times[0] } : { kind };
  }
  return agents.some((a) => a.status === 'queued') ? { kind: 'queued' } : null;
}
