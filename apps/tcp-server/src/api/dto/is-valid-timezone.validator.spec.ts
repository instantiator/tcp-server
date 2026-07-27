import { IsOptional, validate } from 'class-validator';
import {
  IsIanaTimeZone,
  normalizeIanaTimeZone,
} from './is-valid-timezone.validator';

class TimeZoneHolder {
  @IsOptional()
  @IsIanaTimeZone()
  timezone?: string;
}

async function errorsFor(timezone: unknown): Promise<string[]> {
  const holder = new TimeZoneHolder();
  (holder as { timezone: unknown }).timezone = timezone;
  const errors = await validate(holder);
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
}

describe('IsIanaTimeZone', () => {
  it.each(['Europe/London', 'America/New_York', 'UTC'])(
    'accepts %s',
    async (timezone) => {
      expect(await errorsFor(timezone)).toEqual([]);
    },
  );

  it.each(['Not/AZone', 'GMT+1', '', 'arbitrary text'])(
    'rejects %s',
    async (timezone) => {
      expect(await errorsFor(timezone)).not.toEqual([]);
    },
  );

  it('passes when the field is absent, since it is optional', async () => {
    expect(await errorsFor(undefined)).toEqual([]);
  });

  it('is case-sensitive, rejecting a lowercase IANA name', async () => {
    expect(await errorsFor('europe/london')).not.toEqual([]);
  });

  it('names the offending value and the expected format in the failure message', async () => {
    const [message] = await errorsFor('not-a-zone');
    expect(message).toContain('not-a-zone');
    expect(message).toContain('Europe/London');
  });
});

describe('normalizeIanaTimeZone', () => {
  it.each([
    ['europe/london', 'Europe/London'],
    ['EUROPE/LONDON', 'Europe/London'],
    ['utc', 'UTC'],
  ])('rewrites %s to its canonical form %s', (input, expected) => {
    expect(normalizeIanaTimeZone(input)).toBe(expected);
  });

  it('leaves an unrecognised string untouched, so IsIanaTimeZone can still reject it', () => {
    expect(normalizeIanaTimeZone('not-a-zone')).toBe('not-a-zone');
  });

  it('leaves non-string values untouched', () => {
    expect(normalizeIanaTimeZone(undefined)).toBeUndefined();
    expect(normalizeIanaTimeZone(42)).toBe(42);
  });
});
