import { windowFor } from './window';

describe('windowFor', () => {
  describe('day', () => {
    it('spans UTC midnight to midnight', () => {
      const result = windowFor('day', new Date('2026-10-04T12:00:00Z'));
      expect(result.start).toEqual(new Date('2026-10-04T00:00:00Z'));
      expect(result.end).toEqual(new Date('2026-10-05T00:00:00Z'));
      expect(result.newStint).toBe(false);
    });

    it('rolls over at the year boundary', () => {
      const result = windowFor('day', new Date('2026-12-31T23:59:00Z'));
      expect(result.start).toEqual(new Date('2026-12-31T00:00:00Z'));
      expect(result.end).toEqual(new Date('2027-01-01T00:00:00Z'));
    });

    it('starts a fresh day just after the boundary', () => {
      const result = windowFor('day', new Date('2027-01-01T00:00:00Z'));
      expect(result.start).toEqual(new Date('2027-01-01T00:00:00Z'));
      expect(result.end).toEqual(new Date('2027-01-02T00:00:00Z'));
    });
  });

  describe('week', () => {
    it('attributes a Sunday to the week starting the previous Monday', () => {
      // 2026-10-04 is a Sunday; its Monday is 2026-09-28.
      const result = windowFor('week', new Date('2026-10-04T23:59:00Z'));
      expect(result.start).toEqual(new Date('2026-09-28T00:00:00Z'));
      expect(result.end).toEqual(new Date('2026-10-05T00:00:00Z'));
    });

    it('starts a new week exactly at Monday 00:00 UTC', () => {
      // 2026-10-05 is the Monday following that Sunday.
      const result = windowFor('week', new Date('2026-10-05T00:00:00Z'));
      expect(result.start).toEqual(new Date('2026-10-05T00:00:00Z'));
      expect(result.end).toEqual(new Date('2026-10-12T00:00:00Z'));
    });
  });

  describe('month', () => {
    it('spans the 1st to the 1st of next month', () => {
      const result = windowFor('month', new Date('2026-12-31T23:59:00Z'));
      expect(result.start).toEqual(new Date('2026-12-01T00:00:00Z'));
      expect(result.end).toEqual(new Date('2027-01-01T00:00:00Z'));
    });

    it('starts the new month right at its boundary', () => {
      const result = windowFor('month', new Date('2027-01-01T00:00:00Z'));
      expect(result.start).toEqual(new Date('2027-01-01T00:00:00Z'));
      expect(result.end).toEqual(new Date('2027-02-01T00:00:00Z'));
    });

    it('handles a leap-year February', () => {
      const result = windowFor('month', new Date('2028-02-29T12:00:00Z'));
      expect(result.start).toEqual(new Date('2028-02-01T00:00:00Z'));
      expect(result.end).toEqual(new Date('2028-03-01T00:00:00Z'));
    });
  });

  describe('<N>h stint', () => {
    it('starts a new stint when there is no anchor yet', () => {
      const now = new Date('2026-10-04T10:00:00Z');
      const result = windowFor('5h', now);
      expect(result.start).toEqual(now);
      expect(result.end).toEqual(new Date('2026-10-04T15:00:00Z'));
      expect(result.newStint).toBe(true);
    });

    it('stays on the same stint while still inside it', () => {
      const stintStart = new Date('2026-10-04T10:00:00Z');
      const now = new Date('2026-10-04T14:59:59Z');
      const result = windowFor('5h', now, stintStart);
      expect(result.start).toEqual(stintStart);
      expect(result.end).toEqual(new Date('2026-10-04T15:00:00Z'));
      expect(result.newStint).toBe(false);
    });

    it('starts a new stint exactly at the previous stint end', () => {
      const stintStart = new Date('2026-10-04T10:00:00Z');
      const now = new Date('2026-10-04T15:00:00Z');
      const result = windowFor('5h', now, stintStart);
      expect(result.start).toEqual(now);
      expect(result.end).toEqual(new Date('2026-10-04T20:00:00Z'));
      expect(result.newStint).toBe(true);
    });
  });
});
