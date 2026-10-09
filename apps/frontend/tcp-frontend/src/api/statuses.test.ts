import { describe, expect, it } from 'vitest';
import { t } from '../strings';
import { agentStatusLabel, statusLabel, taskWaitingLabel } from './statuses';

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
  it('reads a paused agent with no reason exactly as statusLabel does', () => {
    expect(agentStatusLabel({ status: 'paused' })).toBe(statusLabel('paused'));
  });

  it.each([
    ['user_input', 'agent.pause.user_input'],
    ['consultation', 'agent.pause.consultation'],
    ['shutdown', 'agent.pause.shutdown'],
    ['spend_cap', 'agent.pause.spend_cap'],
    ['manual', 'agent.pause.manual'],
    ['restart', 'agent.pause.restart'],
  ] as const)('says why a %s pause is paused', (pauseReason, key) => {
    expect(agentStatusLabel({ status: 'paused', pauseReason })).toBe(t(key));
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

describe('taskWaitingLabel', () => {
  it('names who paused it', () => {
    expect(taskWaitingLabel({ kind: 'manual', pausedBy: 'Ann' })).toBe(
      t('task.waiting.manual', { name: 'Ann' }),
    );
  });

  it('copes with an unnamed manual pause', () => {
    expect(taskWaitingLabel({ kind: 'manual' })).toBe(
      t('task.waiting.manualAnonymous'),
    );
  });

  it('says when a rate limit will next be tried', () => {
    const resumeAfter = '2026-08-10T09:05:00.000Z';
    expect(taskWaitingLabel({ kind: 'rate_limited', resumeAfter })).toBe(
      t('activity.status.rateLimited', { time: nextTry(resumeAfter) }),
    );
  });

  it('says resume by hand for a rate limit with no retry time', () => {
    expect(taskWaitingLabel({ kind: 'rate_limited' })).toBe(
      t('activity.status.rateLimited.manual'),
    );
  });

  it.each([
    ['spend_cap', 'task.waiting.spend_cap'],
    ['shutdown', 'task.waiting.shutdown'],
    ['restart', 'task.waiting.restart'],
    ['user_input', 'task.waiting.user_input'],
    ['consultation', 'task.waiting.consultation'],
    ['queued', 'task.waiting.queued'],
  ] as const)('has a sentence for %s', (kind, key) => {
    expect(taskWaitingLabel({ kind })).toBe(t(key));
  });
});
