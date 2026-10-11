import { CalcError } from './calc-error';
import { calculate } from './calculate';

describe('calculate', () => {
  it.each([
    ['2+3*4', '14'],
    ['(2+3)*4', '20'],
    ['0.1 + 0.2', '0.3'],
    ['120 * 20%', '24'],
    ['50%', '0.5'],
    ['-2^2', '-4'],
    ['2^3^2', '512'],
    ['2^-2', '0.25'],
    ['round(2.675, 2)', '2.68'],
    ['round_even(2.665, 2)', '2.66'],
    ['round(2.5)', '3'],
    ['floor(-1.5)', '-2'],
    ['ceil(1.2)', '2'],
    ['abs(-3)', '3'],
    ['1/3', '0.33333333333333333333'],
    ['10/4', '2.5'],
    ['2.50*2', '5'],
    ['min(3, 1, 2)', '1'],
    ['max(3, 1, 2)', '3'],
    ['-0*1', '0'],
    ['.5 + .5', '1'],
    ['12345678901234567890.12 * 3', '37037036703703703670.36'],
  ])('%s = %s', (expression, expected) => {
    expect(calculate(expression)).toBe(expected);
  });

  it('rejects division by zero', () => {
    expect(() => calculate('1/0')).toThrow(/division by zero/);
  });

  it('rejects fractional powers', () => {
    expect(() => calculate('2^0.5')).toThrow(/whole-number powers/);
  });

  it('rejects thousands separators and says what to write', () => {
    expect(() => calculate('1,000 + 1')).toThrow(/thousands separators.*1000/);
  });

  it('still allows commas between function arguments', () => {
    expect(calculate('max(1, 2)')).toBe('2');
  });

  it('reports the position of an unclosed bracket', () => {
    expect(() => calculate('(1+2')).toThrow(/at position 4/);
  });

  it('reports the position of a stray closing bracket', () => {
    expect(() => calculate('1+2)')).toThrow(/at position 3/);
  });

  it('rejects over-long expressions', () => {
    expect(() => calculate('1'.repeat(1001))).toThrow(/longer than 1000/);
  });

  it('rejects excessive nesting but allows 100 levels', () => {
    expect(calculate(`${'('.repeat(99)}1${')'.repeat(99)}`)).toBe('1');
    expect(() => calculate(`${'('.repeat(101)}1${')'.repeat(101)}`)).toThrow(
      /nested/,
    );
  });

  it.each(['process', 'constructor', '__proto__', 'toString', 'x'])(
    'rejects the name %s',
    (name) => {
      expect(() => calculate(`${name}(1)`)).toThrow(
        /unknown name .* allowed functions are round, round_even/,
      );
      expect(() => calculate(name)).toThrow(CalcError);
    },
  );

  it('rejects empty input', () => {
    expect(() => calculate('')).toThrow(/empty/);
    expect(() => calculate('   ')).toThrow(/empty/);
  });

  it.each(['round()', 'round(1, 2, 3)', 'round_even(1)', 'abs(1, 2)', 'min()'])(
    'rejects wrong arity: %s',
    (expression) => {
      expect(() => calculate(expression)).toThrow(CalcError);
    },
  );

  it('rejects out-of-range decimal places', () => {
    expect(() => calculate('round(1.5, 21)')).toThrow(/decimal places/);
    expect(() => calculate('round(1.5, 0.5)')).toThrow(/decimal places/);
  });

  it('rejects characters outside the grammar', () => {
    expect(() => calculate('1 & 2')).toThrow(/unexpected character '&'/);
  });

  it('has no modulo operator', () => {
    expect(() => calculate('5 % 2')).toThrow(CalcError);
  });
});
