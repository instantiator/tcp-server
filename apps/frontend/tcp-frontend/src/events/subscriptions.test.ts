import type { WireEvent } from '@tcp/shared/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { connect } from './connect';
import {
  MAX_STREAMS,
  openStreamCount,
  streamUrls,
  subscribe,
} from './subscriptions';

// The manager's job is which connections exist and when, not what happens
// inside one. Reconnection is proven in `connect.test.ts`.
vi.mock('./connect', () => ({ connect: vi.fn() }));

const connectMock = vi.mocked(connect);
const close = vi.fn();

/** Hands the event callback of the nth `connect` call an event. */
const emitOn = (call: number, event: WireEvent) => {
  connectMock.mock.calls[call]?.[1](event);
};

const anEvent: WireEvent = {
  type: 'audit',
  event: {
    timestamp: '2026-08-07T00:00:00.000Z',
    companyId: 'c1',
    role: 'system',
    agentId: null,
    assignmentId: null,
    taskId: null,
    eventType: 'state_change',
    payload: { entity: 'task' },
  },
};

beforeEach(() => {
  connectMock.mockReturnValue({ close });
});

afterEach(() => {
  // Every test closes what it opened, so the module-level map starts empty.
  expect(openStreamCount()).toBe(0);
  vi.clearAllMocks();
});

describe('subscribe', () => {
  it('opens one connection for two subscribers to the same stream', () => {
    const first = vi.fn();
    const second = vi.fn();

    const dropFirst = subscribe(streamUrls.company('c1'), first, vi.fn());
    const dropSecond = subscribe(streamUrls.company('c1'), second, vi.fn());

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(openStreamCount()).toBe(1);

    emitOn(0, anEvent);
    expect(first).toHaveBeenCalledWith(anEvent);
    expect(second).toHaveBeenCalledWith(anEvent);

    dropFirst();
    dropSecond();
  });

  it('opens a separate connection per distinct stream', () => {
    const drops = [
      subscribe(streamUrls.company('c1'), vi.fn(), vi.fn()),
      subscribe(streamUrls.task('t1'), vi.fn(), vi.fn()),
      subscribe(streamUrls.agent('a1'), vi.fn(), vi.fn()),
    ];

    expect(connectMock).toHaveBeenCalledTimes(3);
    expect(connectMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/company/c1/events',
      '/api/task/t1/events',
      '/api/agent/a1/events',
    ]);

    for (const drop of drops) drop();
  });

  it('closes the connection only after the last subscriber leaves', () => {
    const dropFirst = subscribe(streamUrls.task('t1'), vi.fn(), vi.fn());
    const dropSecond = subscribe(streamUrls.task('t1'), vi.fn(), vi.fn());

    dropFirst();
    expect(close).not.toHaveBeenCalled();
    expect(openStreamCount()).toBe(1);

    dropSecond();
    expect(close).toHaveBeenCalledTimes(1);
    expect(openStreamCount()).toBe(0);
  });

  // StrictMode double-invokes effects, so an unsubscribe that ran twice would
  // tear down the connection its own remount had just reopened — and the
  // symptom is a view that silently stops updating, not an error.
  it('ignores a second unsubscribe rather than closing a reopened stream', () => {
    const drop = subscribe(streamUrls.task('t1'), vi.fn(), vi.fn());
    drop();
    expect(close).toHaveBeenCalledTimes(1);

    const reopened = subscribe(streamUrls.task('t1'), vi.fn(), vi.fn());
    expect(connectMock).toHaveBeenCalledTimes(2);

    drop();
    expect(close).toHaveBeenCalledTimes(1);
    expect(openStreamCount()).toBe(1);

    reopened();
  });

  it('delivers a stream failure to every subscriber of that stream', () => {
    const first = vi.fn();
    const second = vi.fn();
    const drops = [
      subscribe(streamUrls.company('c1'), vi.fn(), first),
      subscribe(streamUrls.company('c1'), vi.fn(), second),
    ];

    const refusal = new Error('refused');
    connectMock.mock.calls[0]?.[2](refusal as never);

    expect(first).toHaveBeenCalledWith(refusal);
    expect(second).toHaveBeenCalledWith(refusal);
    for (const drop of drops) drop();
  });

  // An unexpected fan-out has to fail visibly. The alternative under HTTP/1.1
  // is the browser queuing connections silently and the view never updating.
  it('refuses to exceed the connection cap, visibly', () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const drops = Array.from({ length: MAX_STREAMS }, (_, i) =>
      subscribe(streamUrls.agent(`a${String(i)}`), vi.fn(), vi.fn()),
    );

    expect(() =>
      subscribe(streamUrls.agent('one-too-many'), vi.fn(), vi.fn()),
    ).toThrow(new RegExp(String(MAX_STREAMS)));
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledTimes(MAX_STREAMS);

    for (const drop of drops) drop();
  });

  it('lets a refused stream open once capacity is freed', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const drops = Array.from({ length: MAX_STREAMS }, (_, i) =>
      subscribe(streamUrls.agent(`a${String(i)}`), vi.fn(), vi.fn()),
    );

    drops[0]?.();
    const late = subscribe(streamUrls.agent('late'), vi.fn(), vi.fn());
    expect(connectMock).toHaveBeenCalledTimes(MAX_STREAMS + 1);

    for (const drop of drops.slice(1)) drop();
    late();
  });

  it('does not count an extra subscriber to an open stream against the cap', () => {
    const drops = Array.from({ length: MAX_STREAMS }, (_, i) =>
      subscribe(streamUrls.agent(`a${String(i)}`), vi.fn(), vi.fn()),
    );

    const extra = subscribe(streamUrls.agent('a0'), vi.fn(), vi.fn());
    expect(connectMock).toHaveBeenCalledTimes(MAX_STREAMS);

    extra();
    for (const drop of drops) drop();
  });
});
