import { virtual } from '@guidepup/virtual-screen-reader';
import { render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANNOUNCE_LOADING_MIN_MS,
  ANNOUNCE_THROTTLE_MS,
  type Announcement,
} from './announcer';
import { useLoadingAnnouncement } from './useLoadingAnnouncement';

const COMPLETION: Announcement = {
  channel: 'companies',
  change: 'announce.tasksCompleted',
};

const Probe = ({
  loading,
  completion = COMPLETION,
}: {
  readonly loading: boolean;
  readonly completion?: Announcement | null;
}) => {
  useLoadingAnnouncement(loading, completion);
  return <p>Companies</p>;
};

/**
 * `StrictMode` is not decoration here. It invokes every effect twice on mount,
 * which is how the real application behaves and how a hook that guards on
 * "have I run?" announces something it should have suppressed.
 */
const renderProbe = (loading: boolean) => {
  const { rerender } = render(
    <StrictMode>
      <Probe loading={loading} />
    </StrictMode>,
  );
  return (next: boolean) =>
    rerender(
      <StrictMode>
        <Probe loading={next} />
      </StrictMode>,
    );
};

const listen = async () => {
  await virtual.start({ container: document.body });
  await virtual.clearSpokenPhraseLog();
};

describe('useLoadingAnnouncement', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(async () => {
    await virtual.stop();
    vi.useRealTimers();
  });

  it('announces a completed wait that was long enough to notice', async () => {
    await listen();
    const rerender = renderProbe(true);

    await vi.advanceTimersByTimeAsync(ANNOUNCE_LOADING_MIN_MS * 2);
    rerender(false);
    await vi.advanceTimersByTimeAsync(ANNOUNCE_THROTTLE_MS * 2);

    expect(await virtual.spokenPhraseLog()).toEqual(['polite: 1 completed']);
  });

  it('says nothing about a wait too short to be worth mentioning', async () => {
    await listen();
    const rerender = renderProbe(true);

    await vi.advanceTimersByTimeAsync(ANNOUNCE_LOADING_MIN_MS / 2);
    rerender(false);
    await vi.advanceTimersByTimeAsync(ANNOUNCE_THROTTLE_MS * 2);

    // Announcing every fast response turns routine interaction into chatter.
    expect(await virtual.spokenPhraseLog()).toEqual([]);
  });

  it('never announces that loading started', async () => {
    await listen();
    const rerender = renderProbe(false);

    // The page sits loaded for a while first, so that a hook which announced
    // the rising edge would find plenty of elapsed time to justify it.
    await vi.advanceTimersByTimeAsync(ANNOUNCE_LOADING_MIN_MS * 2);
    rerender(true);
    await vi.advanceTimersByTimeAsync(ANNOUNCE_THROTTLE_MS * 2);

    expect(await virtual.spokenPhraseLog()).toEqual([]);
  });

  it('measures the wait from when it started, not from when the page mounted', async () => {
    await listen();
    const rerender = renderProbe(false);

    await vi.advanceTimersByTimeAsync(ANNOUNCE_LOADING_MIN_MS * 5);
    rerender(true);
    await vi.advanceTimersByTimeAsync(ANNOUNCE_LOADING_MIN_MS / 2);
    rerender(false);
    await vi.advanceTimersByTimeAsync(ANNOUNCE_THROTTLE_MS * 2);

    // The wait itself was brief; only the time before it was long. Measuring
    // from mount would announce a half-second refresh as though it mattered.
    expect(await virtual.spokenPhraseLog()).toEqual([]);
  });

  it('announces once under StrictMode, not twice', async () => {
    await listen();
    const rerender = renderProbe(true);

    await vi.advanceTimersByTimeAsync(ANNOUNCE_LOADING_MIN_MS * 2);
    rerender(false);
    await vi.advanceTimersByTimeAsync(ANNOUNCE_THROTTLE_MS * 2);

    // The announcer counts repeats rather than de-duplicating them, so a
    // double-invoked effect says "2 completed" — the wrong number, from the
    // right code. This gates a future implementation that grows run-count
    // state; today's has none to spend.
    expect(await virtual.spokenPhraseLog()).toEqual(['polite: 1 completed']);
  });

  it('announces nothing on arrival at a page that is already loaded', async () => {
    await listen();
    renderProbe(false);

    await vi.advanceTimersByTimeAsync(ANNOUNCE_THROTTLE_MS * 2);

    expect(await virtual.spokenPhraseLog()).toEqual([]);
  });

  it('announces nothing when the wait did not end in success', async () => {
    await listen();
    const { rerender } = render(
      <StrictMode>
        <Probe loading={true} completion={null} />
      </StrictMode>,
    );

    await vi.advanceTimersByTimeAsync(ANNOUNCE_LOADING_MIN_MS * 2);
    rerender(
      <StrictMode>
        <Probe loading={false} completion={null} />
      </StrictMode>,
    );
    await vi.advanceTimersByTimeAsync(ANNOUNCE_THROTTLE_MS * 2);

    // A failed request stops loading exactly as a successful one does. Without
    // this the caller gets two announcements for one event — `ErrorState`'s
    // assertive failure and a polite "loaded" that is not true — and only the
    // second one is heard as an answer to what the user asked for.
    expect(await virtual.spokenPhraseLog()).toEqual([]);
  });
});
