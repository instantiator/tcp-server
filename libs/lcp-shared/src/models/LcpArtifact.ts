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

/**
 * Common near-miss spellings an LLM produces, mapped to the canonical type.
 * `file`/`text` are the short forms now advertised to agents (see
 * `tasks-tools.service.ts`) as easier to guess than the fully descriptive
 * canonical names; the rest are synonyms an LLM might reach for instead.
 */
const ARTIFACT_TYPE_ALIASES: Record<string, LcpArtifactType> = {
  text: 'inline-text',
  inline: 'inline-text',
  string: 'inline-text',
  file: 'assignment-working-path',
  'working-file': 'assignment-working-path',
  path: 'assignment-working-path',
  filename: 'assignment-working-path',
  'material-file': 'task-materials-path',
  'completed-file': 'assignment-completed-path',
};

/**
 * Short, LLM-facing name for each canonical artifact type — the inverse of
 * {@link ARTIFACT_TYPE_ALIASES}' primary short forms. Used when reporting
 * valid values back to an agent so the corrective message matches the
 * vocabulary it was actually shown in the tool description, not the longer
 * internal storage-path name.
 */
const ARTIFACT_TYPE_DISPLAY_NAMES: Record<LcpArtifactType, string> = {
  'inline-text': 'text',
  'assignment-working-path': 'file',
  'task-materials-path': 'material-file',
  'assignment-completed-path': 'completed-file',
  'task-completed-path': 'task-completed-path',
};

/** Maps canonical artifact types to their short, LLM-facing display name. */
export function artifactTypeDisplayName(type: string): string {
  return ARTIFACT_TYPE_DISPLAY_NAMES[type as LcpArtifactType] ?? type;
}

/**
 * Normalises a caller-supplied artifact `type` to its canonical form so common
 * LLM near-misses are accepted instead of rejected: case is folded, spaces and
 * underscores become hyphens (`inline_text` → `inline-text`), and a few word
 * aliases map through {@link ARTIFACT_TYPE_ALIASES} (`text` → `inline-text`).
 * An unrecognised value is returned normalised (still invalid — the caller's
 * validation then reports it against the allowed set).
 */
export function canonicalArtifactType(raw: string): string {
  const normalised = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  return ARTIFACT_TYPE_ALIASES[normalised] ?? normalised;
}

/** Returns a copy of `artifacts` with each `type` run through {@link canonicalArtifactType}. */
export function canonicaliseArtifacts<T extends LcpArtifact>(
  artifacts: T[],
): T[] {
  return artifacts.map((a) => ({
    ...a,
    type: canonicalArtifactType(a.type) as LcpArtifactType,
  }));
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
