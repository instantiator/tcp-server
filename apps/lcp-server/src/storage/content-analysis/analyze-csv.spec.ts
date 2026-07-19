import { analyzeCsv } from './analyze-csv';

describe('analyzeCsv', () => {
  it('reports the header row and data row count', () => {
    const result = analyzeCsv({}, 'name,age\nAlice,30\nBob,25\n');
    expect(result.format).toBe('csv');
    expect(result.columns).toEqual(['name', 'age']);
    expect(result.rowCount).toBe(2);
  });

  it('reports zero data rows for a header-only file', () => {
    const result = analyzeCsv({}, 'name,age\n');
    expect(result.columns).toEqual(['name', 'age']);
    expect(result.rowCount).toBe(0);
  });

  it('reports format=csv-invalid for unparseable content, without throwing', () => {
    const result = analyzeCsv({}, 'a,"unterminated quote\n1,2\n');
    expect(result.format).toBe('csv-invalid');
  });

  it('preserves the base fields (path/size/contentType)', () => {
    const result = analyzeCsv(
      { path: 'a.csv', size: 12, contentType: 'text/csv' },
      'a,b\n1,2\n',
    );
    expect(result.path).toBe('a.csv');
    expect(result.size).toBe(12);
    expect(result.contentType).toBe('text/csv');
  });
});
