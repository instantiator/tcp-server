import type { UUID } from 'crypto';
import type {
  LcpAssignment,
  LcpAssignmentMode,
  LcpAssignmentStatus,
} from '../models/LcpAssignment.model';
import type { TaskChangeSummary } from './company-events';

/** Minimal assignment summary carried in task SSE payloads. */
export interface AssignmentChangeSummary {
  id: UUID;
  status: LcpAssignmentStatus;
  mode: LcpAssignmentMode;
  orderIndex: number | null;
}

/** Builds an {@link AssignmentChangeSummary} from an assignment. */
export function buildAssignmentChangeSummary(
  assignment: Pick<LcpAssignment, 'id' | 'status' | 'mode' | 'orderIndex'>,
): AssignmentChangeSummary {
  return {
    id: assignment.id,
    status: assignment.status,
    mode: assignment.mode,
    orderIndex: assignment.orderIndex ?? null,
  };
}

/**
 * A single event describing a change to a task or one of its assignments.
 * Streamed to clients over `GET /api/task/:id/events` (SSE).
 */
export type TaskEvent = { timestamp: string } & (
  | {
      /** The task itself changed status. */
      kind: 'task_changed';
      data: TaskChangeSummary;
    }
  | {
      /** One of the task's assignments changed status. */
      kind: 'assignment_changed';
      data: AssignmentChangeSummary;
    }
);

/** Redis pub/sub channel carrying {@link TaskEvent}s for one task. */
export const taskEventsChannel = (taskId: string): string =>
  `task:events:${taskId}`;
