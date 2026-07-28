import { validateCsv } from './csv-validator';

describe('validateCsv', () => {
  it('accepts a well-formed CSV with a consistent column count', () => {
    const result = validateCsv('a,b,c\n1,2,3\n4,5,6\n');
    expect(result.valid).toBe(true);
  });

  it('rejects an inconsistent column count across rows', () => {
    const result = validateCsv('a,b,c\n1,2,3\n4,5\n');
    expect(result.valid).toBe(false);
    expect(result.errors[0].llmHint).toMatch(/could not be parsed as CSV/);
  });

  it('rejects unparseable content', () => {
    const result = validateCsv('a,"unterminated quote\n1,2\n');
    expect(result.valid).toBe(false);
  });
});
