import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv';

describe('parseCsv', () => {
  it('splits simple rows and fields', () => {
    expect(parseCsv('a,b\nc,d')).toEqual({
      rows: [
        ['a', 'b'],
        ['c', 'd'],
      ],
      truncated: false,
    });
  });

  it('keeps a comma inside a quoted field', () => {
    expect(parseCsv('"a,b",c').rows).toEqual([['a,b', 'c']]);
  });

  it('reads "" inside quotes as one quote', () => {
    expect(parseCsv('"say ""hi""",x').rows).toEqual([['say "hi"', 'x']]);
  });

  it('keeps a newline inside a quoted field', () => {
    expect(parseCsv('"a\nb",c\nd,e').rows).toEqual([
      ['a\nb', 'c'],
      ['d', 'e'],
    ]);
  });

  it('accepts CRLF row ends', () => {
    expect(parseCsv('a,b\r\nc,d\r\n').rows).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('does not make an empty row of a single trailing newline', () => {
    expect(parseCsv('a,b\n').rows).toEqual([['a', 'b']]);
  });

  it('keeps empty fields', () => {
    expect(parseCsv('a,,c').rows).toEqual([['a', '', 'c']]);
  });

  it('truncates beyond maxRows and says so', () => {
    expect(parseCsv('1\n2\n3', 2)).toEqual({
      rows: [['1'], ['2']],
      truncated: true,
    });
  });

  it('is not truncated at exactly maxRows', () => {
    expect(parseCsv('1\n2', 2).truncated).toBe(false);
  });
});
