import Decimal from 'decimal.js';
import { CalcError } from './calc-error';

/** Working precision is far beyond the 20 decimal places we return, so rounding only happens once. */
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

const MAX_LENGTH = 1000;
const MAX_DEPTH = 100;
const MAX_POWER = 1000;
const RESULT_PLACES = 20;

interface Token {
  kind: 'num' | 'name' | 'op' | 'end';
  text: string;
  pos: number;
}

interface FunctionSpec {
  min: number;
  max: number;
  apply: (args: Decimal[], pos: number) => Decimal;
}

/** Reads a whole-number decimal-places argument, so rounding can never be asked for nonsense. */
function places(value: Decimal, pos: number): number {
  if (!value.isInteger() || value.lt(0) || value.gt(RESULT_PLACES)) {
    throw new CalcError(
      `decimal places must be a whole number from 0 to ${RESULT_PLACES}`,
      pos,
    );
  }
  return value.toNumber();
}

/** Looked up with a Map, never by property access, so names like `constructor` stay unknown. */
const FUNCTIONS: ReadonlyMap<string, FunctionSpec> = new Map<
  string,
  FunctionSpec
>([
  [
    'round',
    {
      min: 1,
      max: 2,
      apply: ([x, dp], pos) =>
        x.toDecimalPlaces(dp ? places(dp, pos) : 0, Decimal.ROUND_HALF_UP),
    },
  ],
  [
    'round_even',
    {
      min: 2,
      max: 2,
      apply: ([x, dp], pos) =>
        x.toDecimalPlaces(places(dp, pos), Decimal.ROUND_HALF_EVEN),
    },
  ],
  ['floor', { min: 1, max: 1, apply: ([x]) => x.floor() }],
  ['ceil', { min: 1, max: 1, apply: ([x]) => x.ceil() }],
  ['abs', { min: 1, max: 1, apply: ([x]) => x.abs() }],
  ['min', { min: 1, max: Infinity, apply: (args) => D.min(...args) }],
  ['max', { min: 1, max: Infinity, apply: (args) => D.max(...args) }],
]);

const FUNCTION_NAMES = [...FUNCTIONS.keys()].join(', ');
const PUNCTUATION = '+-*/^%(),';
const isDigit = (c: string | undefined): boolean =>
  c !== undefined && c >= '0' && c <= '9';
const isLetter = (c: string): boolean => /[A-Za-z_]/.test(c);

/** Splits the expression into tokens, rejecting anything outside the grammar up front. */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) {
      i++;
    } else if (isDigit(c) || (c === '.' && isDigit(source[i + 1]))) {
      const start = i;
      while (isDigit(source[i])) i++;
      if (source[i] === '.') {
        i++;
        if (!isDigit(source[i])) {
          throw new CalcError(
            'a decimal point must be followed by digits, e.g. 5.0 not 5.',
            start,
          );
        }
        while (isDigit(source[i])) i++;
      }
      // A comma followed by exactly three digits reads as a thousands separator.
      if (source[i] === ',' && /^\d{3}(?!\d)/.test(source.slice(i + 1))) {
        throw new CalcError(
          'thousands separators are not allowed — write 1000 not 1,000 (put a space after commas between function arguments)',
          i,
        );
      }
      tokens.push({ kind: 'num', text: source.slice(start, i), pos: start });
    } else if (isLetter(c)) {
      const start = i;
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) i++;
      tokens.push({ kind: 'name', text: source.slice(start, i), pos: start });
    } else if (PUNCTUATION.includes(c)) {
      tokens.push({ kind: 'op', text: c, pos: i++ });
    } else {
      throw new CalcError(
        `unexpected character '${c}' — use only numbers, + - * / ^ %, parentheses and the functions ${FUNCTION_NAMES}`,
        i,
      );
    }
  }
  tokens.push({ kind: 'end', text: '', pos: source.length });
  return tokens;
}

/**
 * Recursive-descent evaluator: each method parses one precedence level and
 * returns its value, so there is no syntax tree and no dynamic code execution.
 */
class Parser {
  private index = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  /** Evaluates the whole token stream, insisting nothing is left over. */
  parse(): Decimal {
    if (this.peek().kind === 'end') {
      throw new CalcError(
        'the expression is empty — write something like 2 + 3 * 4',
      );
    }
    const value = this.expression();
    const extra = this.peek();
    if (extra.kind !== 'end') {
      throw new CalcError(
        `unexpected '${extra.text}' — check for an unbalanced bracket or a missing operator`,
        extra.pos,
      );
    }
    return value;
  }

  private peek(): Token {
    return this.tokens[this.index];
  }

  private isOp(text: string): boolean {
    const token = this.peek();
    return token.kind === 'op' && token.text === text;
  }

  private expect(text: string): void {
    if (!this.isOp(text)) {
      const token = this.peek();
      const found =
        token.kind === 'end' ? 'the end of the expression' : `'${token.text}'`;
      throw new CalcError(`expected '${text}' but found ${found}`, token.pos);
    }
    this.index++;
  }

  /** Lowest precedence: `+` and `-`. */
  private expression(): Decimal {
    let left = this.term();
    while (this.isOp('+') || this.isOp('-')) {
      const plus = this.tokens[this.index++].text === '+';
      const right = this.term();
      left = plus ? left.plus(right) : left.minus(right);
    }
    return left;
  }

  /** `*` and `/`. */
  private term(): Decimal {
    let left = this.unary();
    while (this.isOp('*') || this.isOp('/')) {
      const op = this.tokens[this.index++];
      const right = this.unary();
      if (op.text === '*') {
        left = left.times(right);
      } else if (right.isZero()) {
        throw new CalcError('division by zero is not allowed', op.pos);
      } else {
        left = left.div(right);
      }
    }
    return left;
  }

  /** Prefix `+`/`-`; every nesting path passes through here, so it also bounds the depth. */
  private unary(): Decimal {
    const token = this.peek();
    if (++this.depth > MAX_DEPTH) {
      throw new CalcError(
        `expression is nested more than ${MAX_DEPTH} levels deep — simplify it`,
        token.pos,
      );
    }
    let value: Decimal;
    if (this.isOp('-')) {
      this.index++;
      value = this.unary().neg();
    } else if (this.isOp('+')) {
      this.index++;
      value = this.unary();
    } else {
      value = this.power();
    }
    this.depth--;
    return value;
  }

  /** `^` is right-associative and binds tighter than a leading minus: -2^2 is -4. */
  private power(): Decimal {
    const base = this.postfix();
    if (!this.isOp('^')) return base;
    const op = this.tokens[this.index++];
    const exponent = this.unary();
    if (!exponent.isInteger() || exponent.abs().gt(MAX_POWER)) {
      throw new CalcError(
        `only whole-number powers from -${MAX_POWER} to ${MAX_POWER} are supported`,
        op.pos,
      );
    }
    if (base.isZero() && exponent.isNegative()) {
      throw new CalcError('zero cannot be raised to a negative power', op.pos);
    }
    return base.pow(exponent);
  }

  /** Postfix `%` divides by 100. */
  private postfix(): Decimal {
    let value = this.primary();
    while (this.isOp('%')) {
      this.index++;
      value = value.div(100);
    }
    return value;
  }

  private primary(): Decimal {
    const token = this.peek();
    if (token.kind === 'num') {
      this.index++;
      return new D(token.text);
    }
    if (token.kind === 'name') return this.call();
    if (this.isOp('(')) {
      this.index++;
      const value = this.expression();
      this.expect(')');
      return value;
    }
    const found =
      token.kind === 'end' ? 'the end of the expression' : `'${token.text}'`;
    throw new CalcError(
      `expected a number, a bracket or a function but found ${found}`,
      token.pos,
    );
  }

  private call(): Decimal {
    const name = this.tokens[this.index++];
    const spec = FUNCTIONS.get(name.text);
    if (!spec) {
      throw new CalcError(
        `unknown name '${name.text}' — allowed functions are ${FUNCTION_NAMES}`,
        name.pos,
      );
    }
    this.expect('(');
    const args: Decimal[] = [];
    if (!this.isOp(')')) {
      do {
        args.push(this.expression());
      } while (this.isOp(',') && ++this.index);
    }
    this.expect(')');
    if (args.length < spec.min || args.length > spec.max) {
      const wanted =
        spec.max === Infinity
          ? `at least ${spec.min}`
          : spec.min === spec.max
            ? `${spec.min}`
            : `${spec.min} to ${spec.max}`;
      throw new CalcError(
        `${name.text}() takes ${wanted} argument(s) but got ${args.length}`,
        name.pos,
      );
    }
    return spec.apply(args, name.pos);
  }
}

/** Rounds to the returned precision and prints plain notation with no trailing zeros or `-0`. */
export function formatDecimal(value: Decimal): string {
  if (!value.isFinite())
    throw new CalcError('the result is too large to represent');
  const rounded = value.toDecimalPlaces(RESULT_PLACES, Decimal.ROUND_HALF_UP);
  return rounded.isZero() ? '0' : rounded.toFixed();
}

/**
 * Evaluates an arithmetic expression exactly, in decimal rather than binary
 * floating point, so 0.1 + 0.2 is 0.3. Throws {@link CalcError} for anything
 * outside the small grammar above.
 */
export function calculate(expression: string): string {
  if (expression.length > MAX_LENGTH) {
    throw new CalcError(
      `expression is longer than ${MAX_LENGTH} characters — split it into smaller calculations`,
    );
  }
  return formatDecimal(new Parser(tokenize(expression)).parse());
}
