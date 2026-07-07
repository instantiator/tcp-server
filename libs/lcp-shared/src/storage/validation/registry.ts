import { DocumentValidator, ValidationResult } from './types';

/**
 * Dispatch registry for document validators, keyed by a path matcher rather
 * than a bare file extension — this is the intervention point for future
 * formats: register a matcher + validator here. See `json-validator.ts` for
 * the canonical example.
 *
 * Matchers are tried in registration order; the first match wins. This lets
 * path-specific rules (e.g. OKF documents under `knowledge/{role}/*.md`) be
 * registered ahead of a more general fallback for the same extension.
 */
interface RegisteredValidator {
  match: (path: string) => boolean;
  validate: DocumentValidator;
}

const registry: RegisteredValidator[] = [];

/** Registers a validator for paths satisfying `match`. Order matters — see above. */
export function registerValidator(
  match: (path: string) => boolean,
  validate: DocumentValidator,
): void {
  registry.push({ match, validate });
}

/** Clears all registered validators. Intended for test isolation. */
export function clearValidators(): void {
  registry.length = 0;
}

/**
 * Validates `content` destined for `path` against the first matching
 * registered validator. Formats with no registered validator are treated as
 * "not validated" (`valid: true`) rather than rejected outright.
 */
export async function validateDocument(
  path: string,
  content: string,
  resolveRef?: (refPath: string) => Promise<string | null>,
): Promise<ValidationResult> {
  for (const entry of registry) {
    if (entry.match(path)) {
      return entry.validate(content, { path, resolveRef });
    }
  }
  return { valid: true, errors: [] };
}
