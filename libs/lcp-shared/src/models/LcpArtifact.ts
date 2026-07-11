/**
 * Where an artifact lives. The three `-path` variants are filenames relative
 * to a location in the task/assignment storage tree (see `storage-keys.ts`);
 * `inline-text` carries literal text directly instead of pointing at storage.
 */
export type LcpArtifactType =
  /** `{companySlug}/tasks/{taskId}/materials/{value}` */
  | 'task-materials-path'
  /** `{companySlug}/tasks/{taskId}/completed/{value}` */
  | 'task-completed-path'
  /**
   * `{companySlug}/tasks/{taskId}/assignments/{orderIndex}/working/{value}`
   * (orphan assignments: `{companySlug}/assignments/{assignmentId}/working/{value}`)
   */
  | 'assignment-working-path'
  /**
   * `{companySlug}/tasks/{taskId}/assignments/{orderIndex}/completed/{value}`;
   * `orderIndex` resolves to the most recent prior assignment whose approved
   * list contains `value` — see `resolveArtifactKey`.
   */
  | 'assignment-completed-path'
  /**
   * Literal text — no storage lookup. As an expectation, an empty `value`
   * matches any text; otherwise `value` is a regex the text must match.
   */
  | 'inline-text';

/** `{ type, value }` pointer to (or literal content of) a single artifact. */
export interface LcpArtifact {
  type: LcpArtifactType;
  value: string;
}

/** An artifact usable as task materials: an uploaded file, a promoted assignment output, or inline text. */
export type LcpMaterialArtifact = LcpArtifact & {
  type: 'task-materials-path' | 'assignment-completed-path' | 'inline-text';
};

/** An artifact living in an assignment's own working directory, or inline text. */
export type LcpAssignmentWorkingArtifact = LcpArtifact & {
  type: 'assignment-working-path' | 'inline-text';
};

/** An artifact promoted into an assignment's completed directory, or inline text. */
export type LcpAssignmentCompletedArtifact = LcpArtifact & {
  type: 'assignment-completed-path' | 'inline-text';
};

/** An artifact promoted into a task's completed directory, or inline text. */
export type LcpTaskCompletedArtifact = LcpArtifact & {
  type: 'task-completed-path' | 'inline-text';
};
