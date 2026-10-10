import { CalcError } from './calc-error';
import { SUPPORTED_UNITS, convertUnits } from './units';

describe('convertUnits', () => {
  it.each([
    ['1', 'lb', 'kg', '0.45359237'],
    ['1', 'st', 'lb', '14'],
    ['1', 'in', 'cm', '2.54'],
    ['2.5', 'KG', 'g', '2500'],
    [' 1 '.trim(), ' Mi ', 'km', '1.609344'],
    ['-3', 'm', 'cm', '-300'],
    ['0', 'kg', 'g', '0'],
  ])('%s %s -> %s = %s', (value, from, to, expected) => {
    expect(convertUnits(value, from, to)).toBe(expected);
  });

  it('refuses to mix dimensions', () => {
    expect(() => convertUnits('1', 'kg', 'cm')).toThrow(
      /can't convert kg \(mass\) to cm \(length\)/,
    );
  });

  it('lists supported units when one is unknown', () => {
    expect(() => convertUnits('1', 'parsec', 'm')).toThrow(
      new RegExp(`supported units are ${SUPPORTED_UNITS}`),
    );
  });

  it.each(['1e3', '1,5', '', 'abc', '.5', '1.'])(
    'rejects the value %j',
    (value) => {
      expect(() => convertUnits(value, 'kg', 'g')).toThrow(CalcError);
    },
  );

  it('lists mass units before length units', () => {
    expect(SUPPORTED_UNITS.startsWith('mg, g, kg')).toBe(true);
  });
});
