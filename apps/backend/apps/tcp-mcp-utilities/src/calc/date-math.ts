/// <reference lib="esnext.temporal" />
import { CalcError } from './calc-error';

/** The operations `date_math` offers; also the tool's `operation` enum. */
export const DATE_OPERATIONS = [
  'add',
  'subtract',
  'add_business_days',
  'difference',
  'tax_year',
] as const;
export type DateOperation = (typeof DATE_OPERATIONS)[number];

/** The `date_math` tool's arguments; each operation reads only the fields it needs. */
export interface DateMathInput {
  operation: DateOperation;
  date: string;
  other_date?: string;
  years?: number;
  months?: number;
  weeks?: number;
  days?: number;
  holidays?: string[];
  tax_year_start?: string;
}

/** A flat result object, returned to the model as JSON. */
export type DateMathResult = Record<string, string | number | boolean>;

const MAX_BUSINESS_DAYS = 10000;
const MAX_SPAN_DAYS = 36525;
const DEFAULT_TAX_YEAR_START = '04-06';

/** Parses a strict YYYY-MM-DD date, naming the field in the error so the caller knows what to fix. */
function parseDate(field: string, value: string): Temporal.PlainDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new CalcError(
      `${field} '${value}' must be a real date in the format YYYY-MM-DD`,
    );
  }
  try {
    return Temporal.PlainDate.from(value, { overflow: 'reject' });
  } catch {
    throw new CalcError(
      `${field} '${value}' is not a real calendar date — use the format YYYY-MM-DD`,
    );
  }
}

function required<T>(
  value: T | undefined,
  field: string,
  operation: string,
): T {
  if (value === undefined)
    throw new CalcError(`${field} is required for ${operation}`);
  return value;
}

/** Whole-number amount; `negative` allows signs for the one field that is a direction (business days). */
function wholeNumber(
  field: string,
  value: number | undefined,
  negative = false,
): number {
  const n = value ?? 0;
  if (!Number.isInteger(n))
    throw new CalcError(`${field} must be a whole number, got ${n}`);
  if (n < 0 && !negative) {
    throw new CalcError(
      `${field} must not be negative — use the subtract operation to go back in time`,
    );
  }
  return n;
}

/** A business day is Monday to Friday and not one of the supplied holidays. */
function isBusinessDay(
  date: Temporal.PlainDate,
  holidays: ReadonlySet<string>,
): boolean {
  return date.dayOfWeek <= 5 && !holidays.has(date.toString());
}

function parseHolidays(holidays: string[] | undefined): Set<string> {
  return new Set(
    (holidays ?? []).map((h) => parseDate('holidays entry', h).toString()),
  );
}

function addOrSubtract(
  input: DateMathInput,
  date: Temporal.PlainDate,
): DateMathResult {
  const years = wholeNumber('years', input.years);
  const months = wholeNumber('months', input.months);
  const weeks = wholeNumber('weeks', input.weeks);
  const days = wholeNumber('days', input.days);
  const move =
    input.operation === 'add'
      ? (d: Temporal.PlainDate, by: Temporal.DurationLike) => d.add(by)
      : (d: Temporal.PlainDate, by: Temporal.DurationLike) => d.subtract(by);
  // Years and months first, as Temporal does, so we can tell whether the day-of-month was clamped.
  const shifted = move(date, { years, months });
  return {
    result: move(shifted, { weeks, days }).toString(),
    clamped: shifted.day !== date.day,
  };
}

function addBusinessDays(
  input: DateMathInput,
  date: Temporal.PlainDate,
): DateMathResult {
  const days = wholeNumber(
    'days',
    required(input.days, 'days', 'add_business_days'),
    true,
  );
  if (Math.abs(days) > MAX_BUSINESS_DAYS) {
    throw new CalcError(
      `days must be between -${MAX_BUSINESS_DAYS} and ${MAX_BUSINESS_DAYS}`,
    );
  }
  const holidays = parseHolidays(input.holidays);
  const step = Math.sign(days);
  let current = date;
  // The start date is never counted: only dates stepped onto can use up the allowance.
  for (let left = Math.abs(days); left > 0;) {
    current = current.add({ days: step });
    if (isBusinessDay(current, holidays)) left--;
  }
  return { result: current.toString() };
}

function difference(
  input: DateMathInput,
  date: Temporal.PlainDate,
): DateMathResult {
  const other = parseDate(
    'other_date',
    required(input.other_date, 'other_date', 'difference'),
  );
  const days = date.until(other, { largestUnit: 'day' }).days;
  if (Math.abs(days) > MAX_SPAN_DAYS)
    throw new CalcError('the two dates are more than 100 years apart');
  const holidays = parseHolidays(input.holidays);
  const [earlier, later] = days < 0 ? [other, date] : [date, other];
  let business = 0;
  // Half-open interval (earlier, later]: the earlier date itself is not counted.
  for (
    let d = earlier.add({ days: 1 });
    Temporal.PlainDate.compare(d, later) <= 0;
    d = d.add({ days: 1 })
  ) {
    if (isBusinessDay(d, holidays)) business++;
  }
  return { days, business_days: days < 0 ? -business : business };
}

function taxYear(
  input: DateMathInput,
  date: Temporal.PlainDate,
): DateMathResult {
  const startText = input.tax_year_start ?? DEFAULT_TAX_YEAR_START;
  if (!/^\d{2}-\d{2}$/.test(startText)) {
    throw new CalcError(
      `tax_year_start '${startText}' must be in the format MM-DD, e.g. 04-06`,
    );
  }
  // 2025 is not a leap year, so 02-29 is rejected as a start day.
  const reference = parseDate('tax_year_start', `2025-${startText}`);
  const thisYearsStart = Temporal.PlainDate.from({
    year: date.year,
    month: reference.month,
    day: reference.day,
  });
  const start =
    Temporal.PlainDate.compare(date, thisYearsStart) >= 0
      ? thisYearsStart
      : thisYearsStart.subtract({ years: 1 });
  const end = start.add({ years: 1 }).subtract({ days: 1 });
  const calendarYear = reference.month === 1 && reference.day === 1;
  const label = calendarYear
    ? `${start.year}`
    : `${start.year}/${String(end.year % 100).padStart(2, '0')}`;
  return { start: start.toString(), end: end.toString(), label };
}

/** Calendar arithmetic on dates (no times): offsets, business days, differences and tax years. */
export function dateMath(input: DateMathInput): DateMathResult {
  const date = parseDate('date', input.date);
  try {
    switch (input.operation) {
      case 'add':
      case 'subtract':
        return addOrSubtract(input, date);
      case 'add_business_days':
        return addBusinessDays(input, date);
      case 'difference':
        return difference(input, date);
      case 'tax_year':
        return taxYear(input, date);
      default:
        throw new CalcError(
          `unknown operation '${String(input.operation)}' — use one of ${DATE_OPERATIONS.join(', ')}`,
        );
    }
  } catch (error) {
    // Temporal throws RangeError when a result leaves the supported calendar range.
    if (error instanceof RangeError)
      throw new CalcError('the result is outside the supported date range');
    throw error;
  }
}
