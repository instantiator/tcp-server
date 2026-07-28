import type { TcpArtifact } from '../models/TcpArtifact';

/**
 * Object-key structure helpers for the task/assignment storage tree, plus
 * {@link resolveArtifactKey} which maps an {@link TcpArtifact} to its full
 * storage key. Kept in `@tcp/shared` so both tcp-server (storage/task
 * services) and tcp-agent (assignment prompt assembly) can resolve keys the
 * same way. tcp-server re-exports these from its `storage/storage-keys.ts`
 * alongside the knowledge-store helpers.
 */

// Task / assignment storage tree (see docs/shared-storage.md):
//
// {company_slug}/
//   tasks/{task_id}/
//     materials/                          ← taskMaterialsKey
//     completed/                          ← taskCompletedKey
//     assignments/{orderIndex}/
//       working/                          ← assignmentWorkingKey
//       completed/                        ← assignmentCompletedKey
//   assignments/{assignment_id}/
//     working/                            ← orphanWorkingKey (orphan assignments only)

/** Object key for a task material: `{companySlug}/tasks/{taskId}/materials/{filename}`. */
export function taskMaterialsKey(
  companySlug: string,
  taskId: string,
  filename: string,
): string {
  return `${taskMaterialsPrefix(companySlug, taskId)}${filename}`;
}

/** Listing prefix for a task's materials directory. */
export function taskMaterialsPrefix(
  companySlug: string,
  taskId: string,
): string {
  return `${companySlug}/tasks/${taskId}/materials/`;
}

/** Object key for a task's completed output: `{companySlug}/tasks/{taskId}/completed/{filename}`. */
export function taskCompletedKey(
  companySlug: string,
  taskId: string,
  filename: string,
): string {
  return `${taskCompletedPrefix(companySlug, taskId)}${filename}`;
}

/** Listing prefix for a task's completed directory. */
export function taskCompletedPrefix(
  companySlug: string,
  taskId: string,
): string {
  return `${companySlug}/tasks/${taskId}/completed/`;
}

/**
 * Object key for a file in a task assignment's working directory:
 * `{companySlug}/tasks/{taskId}/assignments/{orderIndex}/working/{filename}`.
 */
export function assignmentWorkingKey(
  companySlug: string,
  taskId: string,
  orderIndex: number,
  filename: string,
): string {
  return `${assignmentWorkingPrefix(companySlug, taskId, orderIndex)}${filename}`;
}

/** Listing prefix for a task assignment's working directory. */
export function assignmentWorkingPrefix(
  companySlug: string,
  taskId: string,
  orderIndex: number,
): string {
  return `${companySlug}/tasks/${taskId}/assignments/${orderIndex}/working/`;
}

/**
 * Object key for a file in a task assignment's completed directory:
 * `{companySlug}/tasks/{taskId}/assignments/{orderIndex}/completed/{filename}`.
 */
export function assignmentCompletedKey(
  companySlug: string,
  taskId: string,
  orderIndex: number,
  filename: string,
): string {
  return `${assignmentCompletedPrefix(companySlug, taskId, orderIndex)}${filename}`;
}

/** Listing prefix for a task assignment's completed directory. */
export function assignmentCompletedPrefix(
  companySlug: string,
  taskId: string,
  orderIndex: number,
): string {
  return `${companySlug}/tasks/${taskId}/assignments/${orderIndex}/completed/`;
}

/**
 * Object key for a file in an orphan assignment's working directory (an
 * assignment with no task — a plain conversation/consultation):
 * `{companySlug}/assignments/{assignmentId}/working/{filename}`.
 */
export function orphanWorkingKey(
  companySlug: string,
  assignmentId: string,
  filename: string,
): string {
  return `${orphanWorkingPrefix(companySlug, assignmentId)}${filename}`;
}

/** Listing prefix for an orphan assignment's working directory. */
export function orphanWorkingPrefix(
  companySlug: string,
  assignmentId: string,
): string {
  return `${companySlug}/assignments/${assignmentId}/working/`;
}

/** Context needed to resolve an {@link TcpArtifact} to a full storage key. */
export interface ArtifactResolutionContext {
  companySlug: string;
  /** The task the artifact belongs to — required for any `task-*-path` or `assignment-*-path` type. */
  task?: { id: string } | null;
  /**
   * The task's implement-mode assignments (the plan), each with its `approved`
   * list populated — required to resolve `assignment-completed-path`.
   */
  planAssignments?: {
    orderIndex?: number | null;
    approved: TcpArtifact[];
  }[];
  /**
   * The assignment the artifact is attached to. Required for
   * `assignment-working-path` (its own working directory — the task
   * assignment's, or the orphan directory when `taskId` is null). Optional
   * for `assignment-completed-path`: when given, only prior assignments
   * (`orderIndex` strictly less than this one's) are considered; when
   * omitted, the whole plan is searched (task-level material references).
   */
  assignment?: {
    id: string;
    taskId?: string | null;
    orderIndex?: number | null;
  } | null;
}

/**
 * Resolves an {@link TcpArtifact} to a full storage key, or `null` for
 * `inline-text` (which carries its value directly, not a storage pointer).
 *
 * For `assignment-completed-path`, scans {@link ArtifactResolutionContext.planAssignments}
 * for the assignment with the highest `orderIndex` (below `ctx.assignment`'s,
 * when given) whose `approved` list contains an entry matching `artifact.value` —
 * the most recent prior version wins.
 *
 * @throws if the context required for the artifact's type is missing, or (for
 *   `assignment-completed-path`) no matching prior assignment is found.
 */
export function resolveArtifactKey(
  artifact: TcpArtifact,
  ctx: ArtifactResolutionContext,
): string | null {
  switch (artifact.type) {
    case 'inline-text':
      return null;

    case 'task-materials-path':
      requireTask(ctx, artifact.type);
      return taskMaterialsKey(ctx.companySlug, ctx.task!.id, artifact.value);

    case 'task-completed-path':
      requireTask(ctx, artifact.type);
      return taskCompletedKey(ctx.companySlug, ctx.task!.id, artifact.value);

    case 'assignment-working-path': {
      if (!ctx.assignment) {
        throw new Error(
          `resolveArtifactKey: '${artifact.type}' requires ctx.assignment`,
        );
      }
      return ctx.assignment.taskId != null && ctx.assignment.orderIndex != null
        ? assignmentWorkingKey(
            ctx.companySlug,
            ctx.assignment.taskId,
            ctx.assignment.orderIndex,
            artifact.value,
          )
        : orphanWorkingKey(ctx.companySlug, ctx.assignment.id, artifact.value);
    }

    case 'assignment-completed-path': {
      requireTask(ctx, artifact.type);
      if (!ctx.planAssignments) {
        throw new Error(
          `resolveArtifactKey: '${artifact.type}' requires ctx.planAssignments`,
        );
      }
      const boundary = ctx.assignment?.orderIndex ?? Number.POSITIVE_INFINITY;
      const match = ctx.planAssignments
        .filter(
          (a) =>
            a.orderIndex != null &&
            a.orderIndex < boundary &&
            a.approved.some((approved) => approved.value === artifact.value),
        )
        .reduce<{
          orderIndex?: number | null;
          approved: TcpArtifact[];
        } | null>(
          (best, a) =>
            best === null || a.orderIndex! > best.orderIndex! ? a : best,
          null,
        );
      if (!match) {
        throw new Error(
          `resolveArtifactKey: no prior assignment has approved '${artifact.value}'`,
        );
      }
      return assignmentCompletedKey(
        ctx.companySlug,
        ctx.task!.id,
        match.orderIndex!,
        artifact.value,
      );
    }
  }
}

function requireTask(ctx: ArtifactResolutionContext, type: string): void {
  if (!ctx.task) {
    throw new Error(`resolveArtifactKey: '${type}' requires ctx.task`);
  }
}
