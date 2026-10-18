/**
 * Parses RFC 4180 CSV: quoted fields may hold commas, newlines and `""` for a
 * literal quote. Returns at most `maxRows` rows, and says if more existed.
 */
export function parseCsv(
  text: string,
  maxRows = 500,
): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (quoted) {
      if (c !== '"') field += c;
      else if (text.charAt(i + 1) === '"') field += text.charAt(i++);
      else quoted = false;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text.charAt(i + 1) === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  // A final row with no newline after it; a trailing newline leaves nothing.
  if (field !== '' || row.length > 0) rows.push([...row, field]);

  return { rows: rows.slice(0, maxRows), truncated: rows.length > maxRows };
}
