import { ValidationResult } from './types';

/**
 * Plain Markdown has no strict grammar to violate, so this is intentionally
 * a no-op that always reports valid. OKF-specific rules (required
 * front-matter) live in `okf-validator.ts` and take precedence for documents
 * under a `knowledge/{role_slug}/` path.
 */
export function validateMarkdown(): ValidationResult {
  return { valid: true, errors: [] };
}
