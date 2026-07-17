import type { UUID } from 'crypto';
import type { LcpAssignment } from '../models/LcpAssignment.model';
import type { LcpTask, LcpTaskStatus } from '../models/LcpTask.model';

/**
 * Minimal task summary carried in company/task SSE payloads (and the task
 * list fetch) — enough for a task-list row to render/update without a
 * refetch. `completedSteps`/`totalSteps` count the task's implement-mode
 * plan assignments (`succeeded` / all).
 */
export interface TaskChangeSummary {
  id: UUID;
  status: LcpTaskStatus;
  request: string;
  shortcode: string;
  createdAt: string;
  updatedAt: string;
  completedSteps: number;
  totalSteps: number;
}

/** Builds a {@link TaskChangeSummary} from a task and its implement-mode plan assignments. */
export function buildTaskChangeSummary(
  task: Pick<
    LcpTask,
    'id' | 'status' | 'request' | 'shortcode' | 'createdAt' | 'updatedAt'
  >,
  planAssignments: Pick<LcpAssignment, 'status'>[],
): TaskChangeSummary {
  return {
    id: task.id,
    status: task.status,
    request: task.request,
    shortcode: task.shortcode,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    completedSteps: planAssignments.filter((a) => a.status === 'succeeded')
      .length,
    totalSteps: planAssignments.length,
  };
}

/**
 * A single event describing a change to a company or one of its tasks.
 * Streamed to clients over `GET /api/company/:id/events` (SSE).
 */
export type CompanyEvent = { timestamp: string } & (
  | {
      /** The company entity itself was updated (e.g. `plannerRoleId`). */
      kind: 'company_changed';
      data: { companyId: UUID };
    }
  | {
      /** One of the company's tasks changed status. */
      kind: 'task_changed';
      data: TaskChangeSummary;
    }
);

/** Redis pub/sub channel carrying {@link CompanyEvent}s for one company. */
export const companyEventsChannel = (companyId: string): string =>
  `company:events:${companyId}`;
