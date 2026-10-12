import type { RecordFieldSchema } from '../../api/dtos';
import type { StringKey } from '../../strings';

/**
 * Turns what a person typed for one field into the value the table stores, or
 * names what is wrong with it. An empty entry means "no value". Dates stay
 * text: the server checks their format, and says so if it is wrong.
 */
export const parseFieldInput = (
  schema: RecordFieldSchema,
  text: string,
): { value: unknown } | { error: StringKey } => {
  const trimmed = text.trim();
  if (trimmed === '') return { value: null };
  switch (schema.type) {
    case 'string':
      return { value: text };
    case 'number':
    case 'integer': {
      const n = Number(trimmed);
      if (schema.type === 'integer' && !Number.isInteger(n)) {
        return { error: 'records.addRow.integer' };
      }
      if (Number.isNaN(n)) return { error: 'records.addRow.number' };
      return { value: n };
    }
    case 'boolean':
      if (trimmed.toLowerCase() === 'true') return { value: true };
      if (trimmed.toLowerCase() === 'false') return { value: false };
      return { error: 'records.addRow.boolean' };
  }
};

/** A row's name for people: its primary key values, e.g. "A1" or "north / A1". */
export const rowLabel = (
  primaryKey: readonly string[],
  data: Readonly<Record<string, unknown>>,
): string =>
  primaryKey
    .map((field) => {
      const value = data[field];
      return typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : '';
    })
    .join(' / ');
