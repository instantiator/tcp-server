import {
  type FieldSchema,
  fieldOrder,
  type RecordData,
  RecordsError,
  type RowError,
  type TableDefinition,
} from '@tcp/shared';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';

/**
 * A text cell starting with one of these is run as a formula by Excel and
 * similar programs. Agents write records from untrusted content (emails,
 * listings), so an export must never hand one over as a live formula.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

/** The guard {@link toCsv} adds to a formula-like text cell, and {@link parseCsv} removes. */
const FORMULA_GUARD = "'";

/** The CSV columns: the table's fields in {@link fieldOrder}. */
export function csvColumns(definition: TableDefinition): string[] {
  return fieldOrder(definition);
}

/** One cell's text. Text that looks like a formula gets a leading `'`, so it opens as text. */
function cellText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') {
    return FORMULA_START.test(value) ? FORMULA_GUARD + value : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  // Schemas hold scalars only; anything else is shown, not lost.
  return JSON.stringify(value);
}

/**
 * Records as CSV, one column per field in {@link fieldOrder} and nothing else (no
 * ids or timestamps), so an exported file can be appended back in.
 */
export function toCsv(
  definition: TableDefinition,
  rows: RecordData[],
  withHeader: boolean,
): string {
  const columns = csvColumns(definition);
  return stringify(
    rows.map((row) => columns.map((c) => cellText(row[c]))),
    { header: withHeader, columns },
  );
}

/** Turns one cell's text into its field's type, or says why it can't. */
function cellValue(
  field: string,
  schema: FieldSchema,
  text: string,
): { value: unknown } | { error: string } {
  switch (schema.type) {
    case 'string':
      return {
        value:
          text.startsWith(FORMULA_GUARD) && FORMULA_START.test(text.slice(1))
            ? text.slice(1)
            : text,
      };
    case 'number':
    case 'integer': {
      const n = Number(text.trim());
      if (
        Number.isNaN(n) ||
        (schema.type === 'integer' && !Number.isInteger(n))
      ) {
        return {
          error: `${field} must be ${schema.type === 'integer' ? 'a whole number' : 'a number'}, not '${text}'`,
        };
      }
      return { value: n };
    }
    case 'boolean': {
      const word = text.trim().toLowerCase();
      if (['true', 'yes', '1'].includes(word)) return { value: true };
      if (['false', 'no', '0'].includes(word)) return { value: false };
      return { error: `${field} must be true or false, not '${text}'` };
    }
  }
}

/**
 * Reads an uploaded CSV into records of the table's types. The first line
 * names the columns; each must be a field of the table, though optional
 * fields may be left out. An empty cell leaves its field out of the record.
 *
 * Row numbers in `errors` count the header as row 1, as a spreadsheet does.
 * Throws a {@link RecordsError} when the file as a whole can't be used.
 */
export function parseCsv(
  definition: TableDefinition,
  text: string,
): { rows: RecordData[]; errors: RowError[] } {
  let cells: string[][];
  try {
    cells = parse(text, { bom: true, skip_empty_lines: true });
  } catch (e) {
    throw new RecordsError(
      `the file isn't valid CSV: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const [header, ...lines] = cells;
  if (!header) throw new RecordsError('the file is empty');
  const fields = definition.schema.properties;
  const unknown = header.filter((h) => !(h in fields));
  if (unknown.length) {
    throw new RecordsError(
      `unknown column${unknown.length > 1 ? 's' : ''} ${unknown.map((u) => `'${u}'`).join(', ')}; the table's fields are ${csvColumns(definition).join(', ')}`,
    );
  }
  const rows: RecordData[] = [];
  const errors: RowError[] = [];
  lines.forEach((line, i) => {
    const record: RecordData = {};
    const problems: string[] = [];
    header.forEach((field, c) => {
      const text = line[c] ?? '';
      if (text === '') return;
      const result = cellValue(field, fields[field], text);
      if ('error' in result) problems.push(result.error);
      else record[field] = result.value;
    });
    if (problems.length)
      errors.push({ row: i + 2, message: problems.join('; ') });
    rows.push(record);
  });
  return { rows, errors };
}
