import Decimal from 'decimal.js';
import { CalcError } from './calc-error';
import { formatDecimal } from './calculate';

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

type Dimension = 'mass' | 'length';

/** Exact factors to the base unit of each dimension (gram, metre). */
const UNITS: ReadonlyMap<string, { dimension: Dimension; toBase: Decimal }> =
  new Map([
    ['mg', { dimension: 'mass', toBase: new D('0.001') }],
    ['g', { dimension: 'mass', toBase: new D('1') }],
    ['kg', { dimension: 'mass', toBase: new D('1000') }],
    ['t', { dimension: 'mass', toBase: new D('1000000') }],
    ['lb', { dimension: 'mass', toBase: new D('453.59237') }],
    ['oz', { dimension: 'mass', toBase: new D('28.349523125') }],
    ['st', { dimension: 'mass', toBase: new D('6350.29318') }],
    ['mm', { dimension: 'length', toBase: new D('0.001') }],
    ['cm', { dimension: 'length', toBase: new D('0.01') }],
    ['m', { dimension: 'length', toBase: new D('1') }],
    ['km', { dimension: 'length', toBase: new D('1000') }],
    ['in', { dimension: 'length', toBase: new D('0.0254') }],
    ['ft', { dimension: 'length', toBase: new D('0.3048') }],
    ['yd', { dimension: 'length', toBase: new D('0.9144') }],
    ['mi', { dimension: 'length', toBase: new D('1609.344') }],
  ]);

/** Comma-separated unit list, mass then length, for tool descriptions and errors. */
export const SUPPORTED_UNITS: string = [...UNITS.keys()].join(', ');

function lookup(name: string): {
  name: string;
  dimension: Dimension;
  toBase: Decimal;
} {
  const key = name.trim().toLowerCase();
  const unit = UNITS.get(key);
  if (!unit) {
    throw new CalcError(
      `unknown unit '${name}' — supported units are ${SUPPORTED_UNITS}`,
    );
  }
  return { name: key, ...unit };
}

/** Converts between units of the same dimension using exact decimal factors. */
export function convertUnits(value: string, from: string, to: string): string {
  if (!/^-?\d+(\.\d+)?$/.test(value)) {
    throw new CalcError(
      `value '${value}' must be a plain decimal number such as 12.5 or -3 (no exponent or commas)`,
    );
  }
  const source = lookup(from);
  const target = lookup(to);
  if (source.dimension !== target.dimension) {
    throw new CalcError(
      `can't convert ${source.name} (${source.dimension}) to ${target.name} (${target.dimension}) — pick two ${source.dimension} units or two ${target.dimension} units`,
    );
  }
  return formatDecimal(new D(value).times(source.toBase).div(target.toBase));
}
