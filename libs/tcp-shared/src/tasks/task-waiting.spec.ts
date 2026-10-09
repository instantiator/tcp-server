import { taskWaiting } from './task-waiting';

const paused = (
  pauseReason: Parameters<typeof taskWaiting>[1][number]['pauseReason'],
  resumeAfter?: string | Date,
) => ({ status: 'paused', pauseReason, resumeAfter });

describe('taskWaiting', () => {
  it('returns null when nothing is holding the task back', () => {
    expect(taskWaiting({}, [{ status: 'running' }])).toBeNull();
  });

  it('puts a task pause above everything its agents report', () => {
    expect(
      taskWaiting({ pausedAt: new Date(), pausedBy: 'ann' }, [
        paused('rate_limited'),
      ]),
    ).toEqual({ kind: 'manual', pausedBy: 'ann' });
  });

  it('omits pausedBy when it is null', () => {
    expect(taskWaiting({ pausedAt: new Date(), pausedBy: null }, [])).toEqual({
      kind: 'manual',
    });
  });

  it('ranks agent pauses rate_limited > spend_cap > shutdown > manual > user_input > consultation', () => {
    const order = [
      'rate_limited',
      'spend_cap',
      'shutdown',
      'manual',
      'user_input',
      'consultation',
    ] as const;
    for (let i = 0; i < order.length; i++) {
      const agents = order.slice(i).map((r) => paused(r));
      expect(taskWaiting({}, agents.reverse())?.kind).toBe(order[i]);
    }
  });

  it('picks the earliest resumeAfter among rate-limited agents', () => {
    expect(
      taskWaiting({}, [
        paused('rate_limited', '2026-01-01T10:00:00.000Z'),
        paused('rate_limited', '2026-01-01T09:00:00.000Z'),
        paused('rate_limited'),
      ]),
    ).toEqual({
      kind: 'rate_limited',
      resumeAfter: '2026-01-01T09:00:00.000Z',
    });
  });

  it('normalises a Date resumeAfter to ISO', () => {
    expect(
      taskWaiting({}, [
        paused('rate_limited', new Date('2026-01-01T09:00:00.000Z')),
      ]),
    ).toEqual({
      kind: 'rate_limited',
      resumeAfter: '2026-01-01T09:00:00.000Z',
    });
  });

  it('reports a rate limit with no retry time as just the kind', () => {
    expect(taskWaiting({}, [paused('rate_limited')])).toEqual({
      kind: 'rate_limited',
    });
  });

  it('reports queued only when no agent is paused', () => {
    expect(taskWaiting({}, [{ status: 'queued' }])).toEqual({ kind: 'queued' });
    expect(
      taskWaiting({}, [{ status: 'queued' }, paused('consultation')]),
    ).toEqual({ kind: 'consultation' });
  });
});
