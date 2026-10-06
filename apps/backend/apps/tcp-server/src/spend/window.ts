import type { CapPeriod } from './spend-caps.config';

// ponytail: UTC only; add a timezone setting when someone asks.

/** The time window a limit is measured over. `newStint` true means the caller must persist `start` as the stint anchor. */
export interface CapWindow {
  start: Date;
  end: Date;
  newStint: boolean;
}

/** Midnight UTC on `date`'s own day. */
function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/** Midnight UTC on the Monday of `date`'s ISO week. */
function startOfUtcWeek(date: Date): Date {
  const day = startOfUtcDay(date);
  // getUTCDay(): 0=Sunday..6=Saturday; ISO weeks start Monday, so Sunday is 6 days after it.
  const daysSinceMonday = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - daysSinceMonday);
  return day;
}

/** Midnight UTC on the 1st of `date`'s month. */
function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/** The window for a calendar period (`month`/`week`/`day`): never a new stint. */
function calendarWindow(
  start: Date,
  addPeriod: (start: Date) => Date,
): CapWindow {
  return { start, end: addPeriod(start), newStint: false };
}

/**
 * The window a cap limit applies to right now. Calendar periods
 * (`month`/`week`/`day`) always use the current UTC period. A `<N>h` stint
 * continues from `stintStart` while `now` is still inside it, otherwise a
 * new stint begins at `now`.
 */
export function windowFor(
  per: CapPeriod,
  now: Date,
  stintStart?: Date,
): CapWindow {
  if (per === 'day') {
    return calendarWindow(startOfUtcDay(now), (start) => {
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 1);
      return end;
    });
  }
  if (per === 'week') {
    return calendarWindow(startOfUtcWeek(now), (start) => {
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 7);
      return end;
    });
  }
  if (per === 'month') {
    return calendarWindow(startOfUtcMonth(now), (start) => {
      const end = new Date(start);
      end.setUTCMonth(end.getUTCMonth() + 1);
      return end;
    });
  }

  const hours = Number(per.slice(0, -1));
  const stintMs = hours * 60 * 60 * 1000;
  if (stintStart && now.getTime() < stintStart.getTime() + stintMs) {
    return {
      start: stintStart,
      end: new Date(stintStart.getTime() + stintMs),
      newStint: false,
    };
  }
  return {
    start: now,
    end: new Date(now.getTime() + stintMs),
    newStint: true,
  };
}
