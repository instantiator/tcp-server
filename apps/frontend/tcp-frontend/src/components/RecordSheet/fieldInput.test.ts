import { describe, expect, it } from 'vitest';
import { parseFieldInput, rowLabel } from './fieldInput';

describe('parseFieldInput', () => {
  it.each([
    [{ type: 'integer' } as const, '3', { value: 3 }],
    [{ type: 'integer' } as const, '3.5', { error: 'records.addRow.integer' }],
    [{ type: 'integer' } as const, 'lots', { error: 'records.addRow.integer' }],
    [{ type: 'number' } as const, '2.5', { value: 2.5 }],
    [{ type: 'number' } as const, 'x', { error: 'records.addRow.number' }],
    [{ type: 'boolean' } as const, 'True', { value: true }],
    [
      { type: 'boolean' } as const,
      'maybe',
      { error: 'records.addRow.boolean' },
    ],
    [{ type: 'string' } as const, ' spaced ', { value: ' spaced ' }],
    [{ type: 'string' } as const, '  ', { value: null }],
  ])('reads %j from %j', (schema, text, expected) => {
    expect(parseFieldInput(schema, text)).toEqual(expected);
  });
});

describe('rowLabel', () => {
  it('joins the primary key values', () => {
    expect(rowLabel(['region', 'id'], { region: 'north', id: 7 })).toBe(
      'north / 7',
    );
  });
});
