/**
 * One field whose supplied value was not among the values it is allowed to
 * take (a "known enumerable value" — a role slug, an artifact type, etc.).
 */
export interface InvalidEnumValue {
  /**
   * Human-facing name of the offending field, worded so the model can find it
   * in its own call — e.g. `assignment 0 role`, `assignment 1 expected type`.
   */
  property: string;
  /** The value the caller actually supplied. */
  value: string;
  /** The values the field is allowed to take. */
  validValues: readonly string[];
}

/**
 * Builds one model-facing validation error that reports EVERY invalid
 * enumerable value at once, so the caller can correct them all in a single
 * retry rather than discovering them one round at a time. Each line names the
 * offending field, the value supplied, and the values it must be one of, in
 * plain English; the message closes with a corrective instruction naming the
 * fields to fix.
 *
 * @param purposeOfTool - Verb phrase naming what the call was trying to do,
 *   completing the closing suffix "If you still intend to …" — e.g.
 *   `create the plan`, `complete the assignment`, `consult that role`.
 * @param invalid - Every invalid enumerable value found this call; must be
 *   non-empty (callers only build a message when something failed).
 */
export function buildEnumValidationError(
  purposeOfTool: string,
  invalid: InvalidEnumValue[],
): string {
  const lines = invalid.map(
    (v) =>
      `- ${v.property}: "${v.value}" is not one of the allowed values. Valid values are: ${v.validValues.join(', ')}.`,
  );
  const properties = invalid.map((v) => v.property).join(', ');
  const heading =
    invalid.length === 1
      ? 'One value was not valid:'
      : `${invalid.length} values were not valid:`;
  return [
    heading,
    ...lines,
    `If you still intend to ${purposeOfTool}, try again with corrected values for ${properties}.`,
  ].join('\n');
}
