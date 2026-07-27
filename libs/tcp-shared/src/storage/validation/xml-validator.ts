import { XMLValidator } from 'fast-xml-parser';
import { ValidationResult } from './types';

/**
 * Well-formedness only. Unlike JSON/YAML/OKF, XML's schema-location
 * convention (`xsi:noNamespaceSchemaLocation`/DTD) has no low-risk local-
 * resolution story worth building for a v1 pass.
 *
 * TODO(schema-validation): xsi:noNamespaceSchemaLocation/DTD resolution
 * intentionally deferred — see docs/prompts/009.4 §Risks.
 */
export function validateXml(content: string): ValidationResult {
  const result = XMLValidator.validate(content);
  if (result === true) {
    return { valid: true, errors: [] };
  }
  const { msg, line } = result.err;
  return {
    valid: false,
    errors: [
      {
        message: msg,
        llmHint: `The file is not well-formed XML (line ${line}): ${msg}. Fix the XML syntax and try again.`,
      },
    ],
  };
}
