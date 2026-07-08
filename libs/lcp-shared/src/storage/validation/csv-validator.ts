import { parse } from 'csv-parse/sync';
import { ValidationResult } from './types';

/**
 * Well-formedness only: the file must parse and have a consistent column
 * count across rows. CSV has no standard schema-in-file convention (CSVW
 * exists but is niche and unused anywhere in this codebase), so there is no
 * local-resolution story to build here.
 *
 * TODO(schema-validation): CSVW/schema-location support intentionally
 * deferred — see docs/prompts/009.4 §Risks.
 */
export function validateCsv(content: string): ValidationResult {
  try {
    parse(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      errors: [
        {
          message,
          llmHint: `The file could not be parsed as CSV: ${message}. Check for a consistent column count across all rows and properly escaped quotes.`,
        },
      ],
    };
  }
  return { valid: true, errors: [] };
}
