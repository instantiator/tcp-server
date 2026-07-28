import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { isLocalSchemaRef } from './schema-ref';
import { ValidationContext, ValidationResult } from './types';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates JSON syntax and, when the document names a local `$schema`
 * reference resolvable via `context.resolveRef`, validates its structure
 * against that schema too. Remote `$schema` URLs are never fetched — see
 * `schema-ref.ts`.
 */
export async function validateJson(
  content: string,
  context: ValidationContext,
): Promise<ValidationResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      errors: [
        {
          message,
          llmHint: `The file is not valid JSON: ${message}. Fix the JSON syntax and try again.`,
        },
      ],
    };
  }

  const schemaRef =
    isPlainObject(parsed) && typeof parsed['$schema'] === 'string'
      ? parsed['$schema']
      : undefined;

  if (!schemaRef || !isLocalSchemaRef(schemaRef) || !context.resolveRef) {
    return { valid: true, errors: [] };
  }

  const schemaText = await context.resolveRef(schemaRef);
  if (!schemaText) {
    // Referenced schema not found — don't fail the document over a broken
    // reference; structural JSON validity already passed.
    return { valid: true, errors: [] };
  }

  let schema: unknown;
  try {
    schema = JSON.parse(schemaText);
  } catch {
    // Malformed schema file isn't the document's fault.
    return { valid: true, errors: [] };
  }

  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validateFn = ajv.compile(schema as object);
  if (validateFn(parsed)) {
    return { valid: true, errors: [] };
  }

  const errors = (validateFn.errors ?? []).map((e) => {
    const location = e.instancePath || '(root)';
    return {
      message: `${location} ${e.message ?? 'is invalid'}`,
      path: e.instancePath,
      llmHint: `Field '${location}' ${e.message ?? 'is invalid'} per the schema declared at '$schema: ${schemaRef}'. Fix the field and try again.`,
    };
  });
  return { valid: false, errors };
}
