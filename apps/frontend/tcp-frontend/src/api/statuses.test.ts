import { describe, expect, it } from 'vitest';
import { t } from '../strings';
import { agentStatusLabel, statusLabel } from './statuses';

/** Matches {@link agentStatusLabel}'s own formatter, so tests don't guess the locale's rendering. */
const nextTry = (iso: string): string =>
  new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(
    new Date(iso),
  );

describe('statusLabel', () => {
  it('names a queued agent "Waiting for model"', () => {
    expect(statusLabel('queued')).toBe(t('activity.status.queued'));
  });
});

describe('agentStatusLabel', () => {
  it('reads an ordinary paused agent exactly as statusLabel does', () => {
    expect(
      agentStatusLabel({ status: 'paused', pauseReason: 'user_input' }),
    ).toBe(statusLabel('paused'));
  });

  it('leaves a non-paused status untouched by pauseReason or resumeAfter', () => {
    expect(
      agentStatusLabel({
        status: 'running',
        pauseReason: 'rate_limited',
        resumeAfter: '2026-08-10T09:05:00.000Z',
      }),
    ).toBe(statusLabel('running'));
  });

  it('says when a rate-limited pause will next be tried', () => {
    const resumeAfter = '2026-08-10T09:05:00.000Z';
    expect(
      agentStatusLabel({
        status: 'paused',
        pauseReason: 'rate_limited',
        resumeAfter,
      }),
    ).toBe(t('activity.status.rateLimited', { time: nextTry(resumeAfter) }));
  });

  it('says resume by hand when auto-resume is off (no resumeAfter)', () => {
    expect(
      agentStatusLabel({
        status: 'paused',
        pauseReason: 'rate_limited',
        resumeAfter: null,
      }),
    ).toBe(t('activity.status.rateLimited.manual'));
  });

  it('says resume by hand when resumeAfter is simply absent', () => {
    expect(
      agentStatusLabel({ status: 'paused', pauseReason: 'rate_limited' }),
    ).toBe(t('activity.status.rateLimited.manual'));
  });
});
