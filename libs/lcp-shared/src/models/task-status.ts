import type { LcpAssignment } from './LcpAssignment.model';
import type { LcpTaskStatus } from './LcpTask.model';

/**
 * Derives a task's status from its current value and its implement-mode
 * assignments (the task's plan). `planning` is never invented here — it is
 * set explicitly when the planner agent is dispatched, and only preserved by
 * rule 5 below while no plan assignments exist yet.
 *
 * Rules, in order:
 * 1. A terminal `current` (`succeeded | failed | cancelled`) always sticks.
 * 2. Any assignment `failed` → `failed`; else any `cancelled` → `cancelled`.
 * 3. Any assignment `in-progress` or `in-qa` → `in-progress`.
 * 4. At least one assignment and all `succeeded` → `succeeded`.
 * 5. `current === 'planning'` and no assignments yet → `planning`.
 * 6. Otherwise → `ready`.
 */
export function deriveTaskStatus(
  current: LcpTaskStatus,
  planAssignments: Pick<LcpAssignment, 'status'>[],
): LcpTaskStatus {
  if (
    current === 'succeeded' ||
    current === 'failed' ||
    current === 'cancelled'
  ) {
    return current;
  }

  if (planAssignments.some((a) => a.status === 'failed')) return 'failed';
  if (planAssignments.some((a) => a.status === 'cancelled')) {
    return 'cancelled';
  }
  if (
    planAssignments.some(
      (a) => a.status === 'in-progress' || a.status === 'in-qa',
    )
  ) {
    return 'in-progress';
  }
  if (
    planAssignments.length > 0 &&
    planAssignments.every((a) => a.status === 'succeeded')
  ) {
    return 'succeeded';
  }
  if (current === 'planning' && planAssignments.length === 0) {
    return 'planning';
  }
  return 'ready';
}

/**
 * Selects the assignments to dispatch next for a task, given its implement-mode
 * plan. The orchestrator must treat the result as a *set* and dispatch each,
 * even though a linear plan yields at most one.
 *
 * Rules:
 * - Something already running (any assignment `in-progress` or `in-qa`) → `[]`.
 * - Otherwise the single `ready` assignment with the lowest `orderIndex` → `[it]`.
 * - Otherwise `[]` (plan complete, failed, or empty).
 *
 * ponytail: this is the DAG extension point. A linear plan selects one step by
 * `orderIndex`; future branch/join plans replace this body with edge-list
 * traversal and may return several ready assignments at once — callers already
 * iterate the returned set, so they need no change.
 */
export function selectNextAssignments<
  T extends Pick<LcpAssignment, 'status' | 'orderIndex'>,
>(planAssignments: T[]): T[] {
  const running = planAssignments.some(
    (a) => a.status === 'in-progress' || a.status === 'in-qa',
  );
  if (running) return [];

  const ready = planAssignments
    .filter((a) => a.status === 'ready' && a.orderIndex != null)
    .sort((a, b) => a.orderIndex! - b.orderIndex!);
  return ready.length > 0 ? [ready[0]] : [];
}
