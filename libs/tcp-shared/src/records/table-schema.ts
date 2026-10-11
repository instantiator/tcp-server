import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import {
  type FieldSchema,
  type FieldType,
  type NewTable,
  type RecordData,
  RecordsError,
  type TableSchema,
} from './records.types';

/** Table and field names: lower-case identifiers, so they read well to a model and never need quoting. */
const NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
const FIELD_TYPES: readonly FieldType[] = [
  'string',
  'number',
  'integer',
  'boolean',
];
/** Key fields must compare exactly, so no floats or booleans. */
const KEY_TYPES: readonly FieldType[] = ['string', 'integer'];

/** Caps that keep one company's tables to a size the agents (and 001.03's views) can work with. */
export const RECORD_LIMITS = {
  tablesPerCompany: 50,
  fieldsPerTable: 50,
  recordBytes: 64 * 1024,
  purposeLength: 1000,
} as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A strict Ajv, so a schema with a misspelt keyword is rejected rather than silently ignored. */
function newAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv;
}

/** Checks one key's field list against the schema, naming the key in any error. */
function checkKey(
  label: string,
  fields: unknown,
  schema: TableSchema,
): string[] {
  if (
    !Array.isArray(fields) ||
    fields.length === 0 ||
    !fields.every((f) => typeof f === 'string')
  ) {
    throw new RecordsError(`${label} must be a non-empty list of field names`);
  }
  if (new Set(fields).size !== fields.length) {
    throw new RecordsError(`${label} names a field twice`);
  }
  for (const field of fields) {
    const property = schema.properties[field];
    if (!property) {
      throw new RecordsError(`${label} names '${field}', which is not a field`);
    }
    if (!KEY_TYPES.includes(property.type)) {
      throw new RecordsError(
        `${label} field '${field}' must be a string or integer, not ${property.type}`,
      );
    }
    if (!schema.required?.includes(field)) {
      throw new RecordsError(
        `${label} field '${field}' must be listed in the schema's "required"`,
      );
    }
  }
  return fields;
}

/**
 * Checks a new table's definition and returns it normalised: the schema is
 * closed (`additionalProperties: false`), so records can only hold the fields
 * the table declares. Throws {@link RecordsError} naming the first problem.
 */
export function checkNewTable(table: NewTable): {
  schema: TableSchema;
  primaryKey: string[];
  uniqueKeys: string[][];
} {
  if (!NAME_PATTERN.test(table.name)) {
    throw new RecordsError(
      `table name '${table.name}' must be lower case letters, digits and underscores, starting with a letter (e.g. customer_orders)`,
    );
  }
  const purpose = table.purpose.trim();
  if (!purpose || purpose.length > RECORD_LIMITS.purposeLength) {
    throw new RecordsError(
      `purpose must say what the table is for, in at most ${RECORD_LIMITS.purposeLength} characters`,
    );
  }
  // Small models often leave out `"type": "object"`; a schema with properties can only mean that.
  const raw: Record<string, unknown> = { type: 'object', ...table.schema };
  if (raw['type'] !== 'object' || !isPlainObject(raw['properties'])) {
    throw new RecordsError(
      'schema must be a JSON Schema object: { "type": "object", "properties": { ... }, "required": [ ... ] }',
    );
  }
  const properties = raw['properties'];
  const names = Object.keys(properties);
  if (names.length === 0 || names.length > RECORD_LIMITS.fieldsPerTable) {
    throw new RecordsError(
      `a table needs between 1 and ${RECORD_LIMITS.fieldsPerTable} fields`,
    );
  }
  for (const name of names) {
    const field = properties[name];
    if (!NAME_PATTERN.test(name)) {
      throw new RecordsError(
        `field name '${name}' must be lower case letters, digits and underscores, starting with a letter`,
      );
    }
    if (
      !isPlainObject(field) ||
      !FIELD_TYPES.includes(field['type'] as FieldType)
    ) {
      throw new RecordsError(
        `field '${name}' must have "type" string, number, integer or boolean (use "format": "date" for dates)`,
      );
    }
  }
  const required = raw['required'];
  if (
    required !== undefined &&
    (!Array.isArray(required) ||
      !required.every((r) => typeof r === 'string' && r in properties))
  ) {
    throw new RecordsError(
      '"required" must list fields that the schema declares',
    );
  }

  const schema = {
    ...raw,
    properties: properties as Record<string, FieldSchema>,
    additionalProperties: false,
  } as TableSchema;
  try {
    newAjv().compile(schema);
  } catch (e) {
    throw new RecordsError(
      `schema is not valid JSON Schema: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const primaryKey = checkKey('primary_key', table.primaryKey, schema);
  const uniqueKeys = (table.uniqueKeys ?? []).map((key, i) =>
    checkKey(`unique_keys[${i}]`, key, schema),
  );
  return { schema, primaryKey, uniqueKeys };
}

/**
 * Compiles a validator for a table's records.
 * ponytail: compiled per call (a millisecond); cache by table id + updatedAt if record writes ever get hot.
 */
export function recordValidator(schema: TableSchema): ValidateFunction {
  return newAjv().compile(schema);
}

/** Validates a record against its table, listing every problem at once so the model can fix them together. */
export function checkRecord(
  validate: ValidateFunction,
  data: RecordData,
): void {
  if (!validate(data)) {
    const problems = (validate.errors ?? []).map((e) => {
      const where = e.instancePath ? e.instancePath.slice(1) : 'record';
      const extra =
        e.keyword === 'additionalProperties'
          ? ` ('${String(e.params['additionalProperty'])}')`
          : '';
      return `${where} ${e.message ?? 'is invalid'}${extra}`;
    });
    throw new RecordsError(
      `the record does not fit the table: ${problems.join('; ')}`,
    );
  }
  if (Buffer.byteLength(JSON.stringify(data)) > RECORD_LIMITS.recordBytes) {
    throw new RecordsError(
      `the record is larger than ${RECORD_LIMITS.recordBytes / 1024} KB`,
    );
  }
}

/** The name a key is stored under, e.g. `order_id` or `marketplace,listing_id`. */
export function keyName(fields: string[]): string {
  return fields.join(',');
}

/** A key's stored value: its fields' values as JSON, in key order. */
export function keyValue(fields: string[], data: RecordData): string {
  return JSON.stringify(fields.map((f) => data[f]));
}

/** JSON with object keys sorted, so two records with the same content compare equal. */
export function canonicalJson(data: RecordData): string {
  return JSON.stringify(
    Object.keys(data)
      .sort()
      .map((k) => [k, data[k]]),
  );
}
