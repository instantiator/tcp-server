import {
  artifactTypeDisplayName,
  InvalidEnumValue,
  TcpArtifact,
} from '@tcp/shared';

/** Artifact types permitted in an assignment's `expected`/`prepared` lists. */
export const WORKING_ARTIFACT_TYPES = new Set([
  'assignment-working-path',
  'inline-text',
]);

/** Artifact types permitted in an assignment's `materials` list. */
export const MATERIAL_ARTIFACT_TYPES = new Set([
  'task-materials-path',
  'assignment-completed-path',
  'inline-text',
]);

/**
 * Renders an allowed artifact-type set in the short, LLM-facing vocabulary
 * (`file`/`text`/...) so a corrective error matches what the tool
 * description advertised, not the longer internal storage-path name.
 */
export function artifactTypeValidValues(allowed: Set<string>): string[] {
  return [...allowed].map(artifactTypeDisplayName);
}

/**
 * Reports every artifact whose `type` falls outside `allowed`, as validation
 * errors naming the types the caller may choose from instead. Distinct by
 * type — one correction per wrong value, however many artifacts used it.
 *
 * @param property - How the offending field is named back to the caller.
 */
export function invalidArtifactTypeErrors(
  artifacts: TcpArtifact[],
  allowed: Set<string>,
  property: string,
): InvalidEnumValue[] {
  const wrong = [
    ...new Set(
      artifacts.map((a) => a.type).filter((type) => !allowed.has(type)),
    ),
  ];
  return wrong.map((value) => ({
    property,
    value,
    validValues: artifactTypeValidValues(allowed),
  }));
}
