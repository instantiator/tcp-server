import { buildPromptDateVars } from './prompt-vars';

describe('buildPromptDateVars', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-06T14:32:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('formats date and datetime as UTC', () => {
    const vars = buildPromptDateVars(null);
    expect(vars.date).toBe('2026-07-06');
    expect(vars.datetime).toBe('2026-07-06 14:32 UTC');
  });

  it('defaults timezone to UTC and mirrors datetime in localDatetime when the company has none', () => {
    const vars = buildPromptDateVars(null);
    expect(vars.timezone).toBe('UTC');
    expect(vars.localDatetime).toBe(vars.datetime);
  });

  it('localizes localDatetime to the company timezone when set', () => {
    const vars = buildPromptDateVars({ timezone: 'America/New_York' });
    expect(vars.timezone).toBe('America/New_York');
    // 14:32 UTC on 2026-07-06 is 10:32 EDT (UTC-4) the same calendar day.
    expect(vars.localDatetime).toBe('2026-07-06 10:32 America/New_York');
    // The UTC anchor is never replaced by localization.
    expect(vars.datetime).toBe('2026-07-06 14:32 UTC');
  });

  it('falls back to the UTC anchor for an invalid/unknown IANA timezone name', () => {
    const vars = buildPromptDateVars({ timezone: 'Not/A_Real_Zone' });
    expect(vars.localDatetime).toBe(vars.datetime);
  });
});
