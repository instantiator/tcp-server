import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { load } from 'js-yaml';
import { isLocalSchemaRef } from './schema-ref';
import { ValidationContext, ValidationResult } from './types';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const YAML_LANGUAGE_SERVER_SCHEMA =
  /^\s*#\s*yaml-language-server:\s*\$schema=(\S+)/m;

function extractSchemaRef(
  content: string,
  parsed: unknown,
): string | undefined {
  if (isPlainObject(parsed) && typeof parsed['$schema'] === 'string') {
    return parsed['$schema'];
  }
  const match = content.match(YAML_LANGUAGE_SERVER_SCHEMA);
  return match ? match[1] : undefined;
}

/**
 * Validates YAML syntax and, when the document names a local `$schema`
 * reference (either a top-level `$schema` key or a leading
 * `# yaml-language-server: $schema=...` comment) resolvable via
 * `context.resolveRef`, validates its structure against that schema too.
 * Remote `$schema` URLs are never fetched — see `schema-ref.ts`.
 */
export async function validateYaml(
  content: string,
  context: ValidationContext,
): Promise<ValidationResult> {
  let parsed: unknown;
  try {
    parsed = load(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      errors: [
        {
          message,
          llmHint: `The file is not valid YAML: ${message}. Fix the YAML syntax and try again.`,
        },
      ],
    };
  }

  const schemaRef = extractSchemaRef(content, parsed);
  if (!schemaRef || !isLocalSchemaRef(schemaRef) || !context.resolveRef) {
    return { valid: true, errors: [] };
  }

  const schemaText = await context.resolveRef(schemaRef);
  if (!schemaText) {
    return { valid: true, errors: [] };
  }

  let schema: unknown;
  try {
    schema = JSON.parse(schemaText);
  } catch {
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
