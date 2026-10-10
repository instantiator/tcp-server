import type { TaskWaiting } from '@tcp/shared/client';
import { taskWaiting } from '@tcp/shared/client';
import { useMemo } from 'react';
import {
  useLiveAssignmentsList,
  useLiveCompanyAgentsList,
  useLiveTaskState,
} from '../../api/hooks';

/** Waiting kinds a user can act on with Resume, even without pausing the task. */
export const RESUMABLE_KINDS: readonly TaskWaiting['kind'][] = [
  'spend_cap',
  'shutdown',
  'rate_limited',
  'manual',
  'restart',
];

/**
 * Why a task is standing still, and whether a pause is still taking effect.
 * Worked out from the live agents rather than read from the detail fetch's
 * `waiting`, which is only as fresh as the last refetch.
 */
export function useTaskWaiting(
  taskId: string,
  companyId: string,
): { readonly waiting: TaskWaiting | null; readonly isPausing: boolean } {
  const task = useLiveTaskState(taskId);
  const assignments = useLiveAssignmentsList({ taskId });
  const { data: companyAgents } = useLiveCompanyAgentsList(companyId);
  const taskAgents = useMemo(() => {
    const ids = new Set(assignments.data?.map((a) => a.id));
    return (companyAgents ?? []).filter((a) => ids.has(a.assignmentId));
  }, [companyAgents, assignments.data]);
  const taskData = task.data;
  return {
    waiting: taskData === undefined ? null : taskWaiting(taskData, taskAgents),
    isPausing:
      Boolean(taskData?.pausedAt) &&
      taskAgents.some((a) => a.status === 'running'),
  };
}
