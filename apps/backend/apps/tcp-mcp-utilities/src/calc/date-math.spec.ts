import { CalcError } from './calc-error';
import { dateMath } from './date-math';

describe('dateMath', () => {
  describe('add / subtract', () => {
    it('clamps to month end and says so', () => {
      expect(
        dateMath({ operation: 'add', date: '2026-01-31', months: 1 }),
      ).toEqual({ result: '2026-02-28', clamped: true });
    });

    it('respects leap years', () => {
      expect(
        dateMath({ operation: 'add', date: '2028-01-31', months: 1 }),
      ).toEqual({ result: '2028-02-29', clamped: true });
    });

    it('reports clamped false when the day survives', () => {
      expect(
        dateMath({ operation: 'add', date: '2026-01-15', months: 1, days: 3 }),
      ).toEqual({ result: '2026-02-18', clamped: false });
    });

    it('does not call day offsets a clamp', () => {
      expect(
        dateMath({ operation: 'add', date: '2026-01-30', days: 5 }),
      ).toEqual({ result: '2026-02-04', clamped: false });
    });

    it('subtracts weeks', () => {
      expect(
        dateMath({ operation: 'subtract', date: '2026-03-01', weeks: 2 }),
      ).toEqual({ result: '2026-02-15', clamped: false });
    });

    it('returns the date unchanged when nothing is given', () => {
      expect(dateMath({ operation: 'add', date: '2026-03-01' })).toEqual({
        result: '2026-03-01',
        clamped: false,
      });
    });

    it('rejects non-integer amounts', () => {
      expect(() =>
        dateMath({ operation: 'add', date: '2026-01-01', months: 1.5 }),
      ).toThrow(/months must be a whole number/);
    });

    it('rejects negative amounts and points to subtract', () => {
      expect(() =>
        dateMath({ operation: 'add', date: '2026-01-01', days: -1 }),
      ).toThrow(/subtract/);
    });
  });

  describe('add_business_days', () => {
    // 2026-10-09 is a Friday.
    it('moves Friday + 1 to Monday', () => {
      expect(
        dateMath({
          operation: 'add_business_days',
          date: '2026-10-09',
          days: 1,
        }),
      ).toEqual({ result: '2026-10-12' });
    });

    it('skips a holiday', () => {
      expect(
        dateMath({
          operation: 'add_business_days',
          date: '2026-10-09',
          days: 1,
          holidays: ['2026-10-12'],
        }),
      ).toEqual({ result: '2026-10-13' });
    });

    it('goes backwards for negative days', () => {
      expect(
        dateMath({
          operation: 'add_business_days',
          date: '2026-10-12',
          days: -1,
        }),
      ).toEqual({ result: '2026-10-09' });
    });

    it('leaves the date alone for zero, even on a weekend', () => {
      expect(
        dateMath({
          operation: 'add_business_days',
          date: '2026-10-11',
          days: 0,
        }),
      ).toEqual({ result: '2026-10-11' });
    });

    it('requires days', () => {
      expect(() =>
        dateMath({ operation: 'add_business_days', date: '2026-10-09' }),
      ).toThrow(/days is required/);
    });

    it('validates holidays', () => {
      expect(() =>
        dateMath({
          operation: 'add_business_days',
          date: '2026-10-09',
          days: 1,
          holidays: ['soon'],
        }),
      ).toThrow(/YYYY-MM-DD/);
    });

    it('caps the distance', () => {
      expect(() =>
        dateMath({
          operation: 'add_business_days',
          date: '2026-10-09',
          days: 10001,
        }),
      ).toThrow(CalcError);
    });
  });

  describe('difference', () => {
    it('counts days and business days across a weekend', () => {
      expect(
        dateMath({
          operation: 'difference',
          date: '2026-10-09',
          other_date: '2026-10-13',
        }),
      ).toEqual({ days: 4, business_days: 2 });
    });

    it('is negative in the reverse direction', () => {
      expect(
        dateMath({
          operation: 'difference',
          date: '2026-10-13',
          other_date: '2026-10-09',
        }),
      ).toEqual({ days: -4, business_days: -2 });
    });

    it('is zero for the same date', () => {
      expect(
        dateMath({
          operation: 'difference',
          date: '2026-10-09',
          other_date: '2026-10-09',
        }),
      ).toEqual({ days: 0, business_days: 0 });
    });

    it('excludes holidays from business days', () => {
      expect(
        dateMath({
          operation: 'difference',
          date: '2026-10-09',
          other_date: '2026-10-13',
          holidays: ['2026-10-12'],
        }),
      ).toEqual({ days: 4, business_days: 1 });
    });

    it('requires other_date', () => {
      expect(() =>
        dateMath({ operation: 'difference', date: '2026-10-09' }),
      ).toThrow(/other_date is required/);
    });

    it('caps the span at 100 years', () => {
      expect(() =>
        dateMath({
          operation: 'difference',
          date: '1900-01-01',
          other_date: '2100-01-01',
        }),
      ).toThrow(/100 years/);
    });
  });

  describe('tax_year', () => {
    it('puts 5 April in the previous UK tax year', () => {
      expect(dateMath({ operation: 'tax_year', date: '2026-04-05' })).toEqual({
        start: '2025-04-06',
        end: '2026-04-05',
        label: '2025/26',
      });
    });

    it('starts the new UK tax year on 6 April', () => {
      expect(dateMath({ operation: 'tax_year', date: '2026-04-06' })).toEqual({
        start: '2026-04-06',
        end: '2027-04-05',
        label: '2026/27',
      });
    });

    it('labels a calendar-year tax year with the year alone', () => {
      expect(
        dateMath({
          operation: 'tax_year',
          date: '2026-07-01',
          tax_year_start: '01-01',
        }),
      ).toEqual({ start: '2026-01-01', end: '2026-12-31', label: '2026' });
    });

    it('rejects 29 February as a start', () => {
      expect(() =>
        dateMath({
          operation: 'tax_year',
          date: '2026-07-01',
          tax_year_start: '02-29',
        }),
      ).toThrow(CalcError);
    });

    it('rejects a badly formatted start', () => {
      expect(() =>
        dateMath({
          operation: 'tax_year',
          date: '2026-07-01',
          tax_year_start: '6 April',
        }),
      ).toThrow(/MM-DD/);
    });
  });

  describe('validation', () => {
    it('rejects an impossible date and names the field', () => {
      expect(() => dateMath({ operation: 'add', date: '2026-02-30' })).toThrow(
        /date '2026-02-30'.*YYYY-MM-DD/,
      );
    });

    it('rejects a wrongly formatted date', () => {
      expect(() => dateMath({ operation: 'add', date: '30/02/2026' })).toThrow(
        /YYYY-MM-DD/,
      );
    });
  });
});
