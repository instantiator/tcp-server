// The compatibility spike ADR-027 asks for: @guidepup/virtual-screen-reader's
// documentation is written against Jest, and ADR-028 chose Vitest. This proves
// the two work together — and proves the assertion ADR-027 actually depends on,
// `spokenPhraseLog()`, reports a coalesced live-region announcement rather than
// a phrase per DOM mutation.
//
// The announcer here is a throwaway. The real one arrives in 003.03; this file
// exists so that prompt inherits a mechanism that is known to work, and a shape
// to copy.
import { render } from '@testing-library/react';
import { virtual } from '@guidepup/virtual-screen-reader';
import { useEffect, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** ADR-027 starts at ~10s; a test-sized interval proves the same behaviour. */
const THROTTLE_MS = 100;

/**
 * Stands in for 003.03's application announcer. Two channels, per ADR-027:
 * the transcript renders every token as it arrives, and the live region says
 * nothing until the response completes.
 */
const StreamingTranscript = ({
  tokens,
  complete,
}: {
  tokens: string[];
  complete: boolean;
}) => {
  const [announcement, setAnnouncement] = useState('');
  const pending = useRef<string[]>([]);

  useEffect(() => {
    if (complete) pending.current.push('Reply from Sales received');
  }, [complete]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (pending.current.length === 0) return;
      setAnnouncement(pending.current.join(', '));
      pending.current = [];
    }, THROTTLE_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  return (
    <>
      <article aria-label="Reply from Sales">{tokens.join(' ')}</article>
      <div role="status">{announcement}</div>
    </>
  );
};

/** Runs the throttle interval to completion inside React's act boundary. */
const advancePastThrottle = () => vi.advanceTimersByTimeAsync(THROTTLE_MS * 2);

describe('the announcement testing mechanism', () => {
  beforeEach(() => {
    // shouldAdvanceTime keeps real time moving underneath the fake clock, so
    // the simulator's own awaits still settle while the throttle is driven
    // deterministically.
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(async () => {
    await virtual.stop();
    vi.useRealTimers();
  });

  it('reports one coalesced phrase, never one per token', async () => {
    const tokens = ['The', 'quick', 'brown', 'fox', 'jumps', 'over'];
    const { rerender } = render(
      <StreamingTranscript tokens={[]} complete={false} />,
    );

    await virtual.start({ container: document.body });
    // start() announces the container itself ("document"). Clear it, so the
    // log holds only what the announcer chose to say.
    await virtual.clearSpokenPhraseLog();

    // Stream the response a token at a time, as the wire delivers it.
    for (let i = 1; i <= tokens.length; i++) {
      rerender(
        <StreamingTranscript tokens={tokens.slice(0, i)} complete={false} />,
      );
      await advancePastThrottle();
    }

    // The rule this whole ADR exists to enforce: six tokens, nothing spoken.
    expect(await virtual.spokenPhraseLog()).toEqual([]);

    rerender(<StreamingTranscript tokens={tokens} complete />);
    await advancePastThrottle();

    // The simulator prefixes each phrase with the region's politeness, so the
    // ADR-027 per-surface politeness column is asserted here too, for free.
    expect(await virtual.spokenPhraseLog()).toEqual([
      'polite: Reply from Sales received',
    ]);
  });

  it('coalesces a burst within one interval into a single announcement', async () => {
    const { rerender } = render(
      <StreamingTranscript tokens={[]} complete={false} />,
    );

    await virtual.start({ container: document.body });
    // start() announces the container itself ("document"). Clear it, so the
    // log holds only what the announcer chose to say.
    await virtual.clearSpokenPhraseLog();

    // Two completions land inside one throttle window.
    rerender(<StreamingTranscript tokens={['a']} complete />);
    rerender(<StreamingTranscript tokens={['a', 'b']} complete />);
    await advancePastThrottle();

    expect(await virtual.spokenPhraseLog()).toHaveLength(1);
  });
});
