import { parse } from 'csv-parse/sync';

/** Analyzes CSV content: header row and row count. */
export function analyzeCsv(
  base: Record<string, unknown>,
  content: string,
): Record<string, unknown> {
  try {
    const rows = parse(content);
    const [columns = [], ...dataRows] = rows;
    return { ...base, format: 'csv', columns, rowCount: dataRows.length };
  } catch {
    return { ...base, format: 'csv-invalid' };
  }
}
