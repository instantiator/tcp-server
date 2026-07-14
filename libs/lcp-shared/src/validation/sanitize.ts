/* eslint-disable no-control-regex -- this module's whole job is matching control chars */

// Control characters a model sometimes emits (ANSI escapes, NUL, vertical tab,
// form feed, DEL, …) carry no meaning in our text fields but make the stored
// JSON unparseable by strict parsers. Strip every C0 control char and DEL,
// keeping the legitimate whitespace `\t` (0x09), `\n` (0x0A) and `\r` (0x0D).
// Built from an ASCII escape string so no literal control char appears here.
const CONTROL_CHARS = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]',
  'g',
);

/**
 * Removes stray control characters from model-produced text before it is
 * stored, so downstream JSON (task/assignment API + CLI output) stays valid for
 * strict parsers. Legitimate whitespace (`\t`, `\n`, `\r`) is preserved.
 */
export function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS, '');
}

/**
 * A minimal `ValueTransformer` shape (avoids a `typeorm` import here — the
 * entity that applies the transformer already depends on it).
 */
interface ValueTransformer {
  to(value: unknown): unknown;
  from(value: unknown): unknown;
}

/**
 * TypeORM column transformer that strips control characters from a **text**
 * column on write — the automatic, can't-be-bypassed sanitisation point for
 * model-produced text fields (`prompt`, `summary`, `qaFeedback`, agent
 * `output`, …). Reads pass through untouched.
 */
export const sanitiseTextColumn: ValueTransformer = {
  to: (v) => (typeof v === 'string' ? stripControlChars(v) : v),
  from: (v) => v,
};

/** Deep-sanitises the `value` of every `{ type, value }` artifact in a list. */
export function sanitiseArtifacts<T extends { value: string }>(
  artifacts: T[] | null | undefined,
): T[] | null | undefined {
  if (!artifacts) return artifacts;
  return artifacts.map((a) =>
    typeof a.value === 'string'
      ? { ...a, value: stripControlChars(a.value) }
      : a,
  );
}

/**
 * TypeORM column transformer for an **artifact-list** column (`materials`,
 * `expected`, `prepared`, `approved`, `completed`): strips control characters
 * from each artifact's `value` on write. Reads pass through untouched.
 */
export const sanitiseArtifactsColumn: ValueTransformer = {
  to: (v) =>
    Array.isArray(v) ? sanitiseArtifacts(v as { value: string }[]) : v,
  from: (v) => v,
};
