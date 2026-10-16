import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import {
  type FieldSchema,
  type FieldType,
  type NewTable,
  type RecordData,
  RecordsError,
  type TableChange,
  type TableDefinition,
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
  rowsPerInsert: 10_000,
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

/** Throws unless `name` is a valid column name that `schema` doesn't already use. */
function checkFreeName(schema: TableSchema, name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new RecordsError(
      `column name '${name}' must be lower case letters, digits and underscores, starting with a letter`,
    );
  }
  if (name in schema.properties) {
    throw new RecordsError(
      `the table already has a column named '${name}' — use describe_table to see its columns`,
      'conflict',
    );
  }
}

/** Throws unless `column` is one of the table's columns. */
function checkExists(schema: TableSchema, column: string): void {
  if (!(column in schema.properties)) {
    throw new RecordsError(
      `the table has no column named '${column}'; its columns are ${Object.keys(schema.properties).join(', ')}`,
      'not_found',
    );
  }
}

/** Whether two field lists name the same fields, in any order. */
function sameFields(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((f) => b.includes(f));
}

/**
 * Checks a new column against its table and returns its field schema. A
 * column can be required only when every existing record will get a value:
 * from `default`, or because there are no records.
 */
export function checkAddColumn(
  table: TableDefinition,
  change: Extract<TableChange, { op: 'add_column' }>,
  records: number,
): FieldSchema {
  checkFreeName(table.schema, change.column);
  if (
    Object.keys(table.schema.properties).length >= RECORD_LIMITS.fieldsPerTable
  ) {
    throw new RecordsError(
      `a table can have at most ${RECORD_LIMITS.fieldsPerTable} columns, and this one is full`,
    );
  }
  if (!FIELD_TYPES.includes(change.type)) {
    throw new RecordsError(
      `type must be string, number, integer or boolean (use "format": "date" with string for dates)`,
    );
  }
  if (change.format !== undefined && change.format !== 'date') {
    throw new RecordsError(`format can only be "date"`);
  }
  if (change.format === 'date' && change.type !== 'string') {
    throw new RecordsError(`a date column must have type string`);
  }
  if (
    change.description !== undefined &&
    change.description.length > RECORD_LIMITS.purposeLength
  ) {
    throw new RecordsError(
      `description can be at most ${RECORD_LIMITS.purposeLength} characters`,
    );
  }
  const field: FieldSchema = { type: change.type };
  if (change.format) field.format = change.format;
  if (change.description) field.description = change.description;
  if (change.default !== undefined) {
    const validate = newAjv().compile(field);
    if (!validate(change.default)) {
      throw new RecordsError(
        `default ${JSON.stringify(change.default)} doesn't fit the column: it ${validate.errors?.[0]?.message ?? 'is not valid'}`,
      );
    }
  }
  if (change.required && change.default === undefined && records > 0) {
    throw new RecordsError(
      `a new column can be required only if every record gets a value: give a default, or leave it optional and fill it in with update`,
    );
  }
  return field;
}

/** Checks a rename: the column exists, and the new name is valid and free. */
export function checkRename(
  table: TableDefinition,
  column: string,
  newName: string,
): void {
  checkExists(table.schema, column);
  if (newName === column) {
    throw new RecordsError(`'${column}' already has that name`);
  }
  checkFreeName(table.schema, newName);
}

/**
 * Checks a column can be deleted. A key column can't: the key would no
 * longer tell records apart. Nor can the column retention counts from.
 */
export function checkDelete(table: TableDefinition, column: string): void {
  checkExists(table.schema, column);
  if (table.primaryKey.includes(column)) {
    throw new RecordsError(
      `'${column}' is in the primary key (${table.primaryKey.join(', ')}); take it out of the key first`,
    );
  }
  if (table.uniqueKeys.some((key) => key.includes(column))) {
    throw new RecordsError(
      `'${column}' is in a unique key, so it can't be deleted`,
    );
  }
  if (table.retention?.from === column) {
    throw new RecordsError(
      `rows are kept for ${table.retention.days} days from '${column}'; change how long rows are kept first`,
    );
  }
}

/**
 * Checks a new primary key against the table's columns. With `allowNarrow`
 * false (agents), every current key field must stay in the key: a narrower
 * key can make different records count as the same one, so only a person
 * may choose it.
 */
export function checkNewKey(
  table: TableDefinition,
  fields: unknown,
  allowNarrow: boolean,
): string[] {
  const key = checkKeyFields(table, 'primary key', fields);
  if (sameFields(key, table.primaryKey)) {
    throw new RecordsError(
      `the primary key is already ${table.primaryKey.join(', ')}`,
    );
  }
  if (table.uniqueKeys.some((unique) => sameFields(key, unique))) {
    throw new RecordsError(
      `${key.join(', ')} is already a unique key; choose a different set of fields`,
    );
  }
  const dropped = table.primaryKey.filter((f) => !key.includes(f));
  if (!allowNarrow && dropped.length) {
    throw new RecordsError(
      `taking ${dropped.join(', ')} out of the key can make different records count as the same one, so only a person can do that. ` +
        `Keep every current key field (${table.primaryKey.join(', ')}) and add to it, or ask a user with request_user_input to change the key in the table's Columns dialog, saying which fields and why`,
    );
  }
  return key;
}

/** A key's field list, checked against the columns; the fields need not be required yet. */
function checkKeyFields(
  table: TableDefinition,
  label: string,
  fields: unknown,
): string[] {
  return checkKey(label, fields, {
    ...table.schema,
    // Every key field becomes required, so don't ask for that up front.
    required: Object.keys(table.schema.properties),
  });
}

/**
 * Checks a new unique key: fields that could be a key, and not the same set
 * as the primary key or another unique key. Only a person may add one: a
 * unique key that is too loose makes different records count as the same.
 */
export function checkNewUniqueKey(
  table: TableDefinition,
  fields: unknown,
  byPerson: boolean,
): string[] {
  if (!byPerson) throw uniqueKeysArePeoples();
  const key = checkKeyFields(table, 'unique key', fields);
  if (sameFields(key, table.primaryKey)) {
    throw new RecordsError(`${key.join(', ')} is already the primary key`);
  }
  if (table.uniqueKeys.some((unique) => sameFields(key, unique))) {
    throw new RecordsError(`${key.join(', ')} is already a unique key`);
  }
  return key;
}

/** Finds the unique key with exactly `fields`, in any order. Only a person may drop one. */
export function checkDropUniqueKey(
  table: TableDefinition,
  fields: unknown,
  byPerson: boolean,
): string[] {
  if (!byPerson) throw uniqueKeysArePeoples();
  const wanted = Array.isArray(fields)
    ? fields.filter((f): f is string => typeof f === 'string')
    : [];
  const found = table.uniqueKeys.find((key) => sameFields(key, wanted));
  if (!found) {
    throw new RecordsError(
      table.uniqueKeys.length
        ? `there is no unique key on ${wanted.join(', ')}; the unique keys are ${table.uniqueKeys.map((k) => `(${k.join(', ')})`).join(', ')}`
        : 'the table has no unique keys',
      'not_found',
    );
  }
  return found;
}

/** The refusal an agent gets for changing unique keys. */
function uniqueKeysArePeoples(): RecordsError {
  return new RecordsError(
    "only a person can change a table's unique keys, because a wrong one can make different records count as the same. " +
      "Ask a user with request_user_input to change it in the table's Columns dialog, saying which fields and why",
  );
}

/**
 * Checks a column can take a new type, and returns its new field schema. A
 * key column must stay text or a whole number; the column retention counts
 * from must stay a date. The description is kept; other keywords (such as a
 * minimum) belonged to the old type, so they go.
 */
export function checkRetype(
  table: TableDefinition,
  change: Extract<TableChange, { op: 'retype_column' }>,
): FieldSchema {
  checkExists(table.schema, change.column);
  if (!FIELD_TYPES.includes(change.type)) {
    throw new RecordsError(
      'type must be string, number, integer or boolean (use "format": "date" with string for dates)',
    );
  }
  if (change.format !== undefined && change.format !== 'date') {
    throw new RecordsError('format can only be "date"');
  }
  if (change.format === 'date' && change.type !== 'string') {
    throw new RecordsError('a date column must have type string');
  }
  const current = table.schema.properties[change.column];
  if (
    current.type === change.type &&
    (current.format === 'date' ? 'date' : undefined) === change.format
  ) {
    throw new RecordsError(`'${change.column}' already has that type`);
  }
  const inKey = [table.primaryKey, ...table.uniqueKeys].some((key) =>
    key.includes(change.column),
  );
  if (inKey && !KEY_TYPES.includes(change.type)) {
    throw new RecordsError(
      `'${change.column}' is in a key, so it must stay text or a whole number`,
    );
  }
  if (table.retention?.from === change.column) {
    throw new RecordsError(
      `rows are kept for ${table.retention.days} days from '${change.column}'; change how long rows are kept first`,
    );
  }
  const field: FieldSchema = { type: change.type };
  if (change.format) field.format = change.format;
  if (typeof current.description === 'string') {
    field.description = current.description;
  }
  return field;
}

/** A calendar date written `YYYY-MM-DD`. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A stored value in a column's new type, or `undefined` when it doesn't
 * convert. Only conversions that lose nothing a person would miss: text that
 * is a number becomes that number, any scalar becomes its text, and text that
 * is already a date or `true`/`false` stays meaningful.
 */
export function convertValue(value: unknown, field: FieldSchema): unknown {
  const text = typeof value === 'string' ? value.trim() : undefined;
  switch (field.type) {
    case 'string':
      if (field.format === 'date') {
        return text !== undefined &&
          DATE_PATTERN.test(text) &&
          !Number.isNaN(Date.parse(text))
          ? text
          : undefined;
      }
      return typeof value === 'string' ? value : String(value);
    case 'number':
    case 'integer': {
      const n =
        typeof value === 'number'
          ? value
          : text !== undefined && text !== ''
            ? Number(text)
            : NaN;
      if (!Number.isFinite(n)) return undefined;
      return field.type === 'integer' && !Number.isInteger(n) ? undefined : n;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (text?.toLowerCase() === 'true') return true;
      if (text?.toLowerCase() === 'false') return false;
      return undefined;
  }
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
