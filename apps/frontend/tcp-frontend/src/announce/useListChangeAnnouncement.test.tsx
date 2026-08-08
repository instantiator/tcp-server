import { virtual } from '@guidepup/virtual-screen-reader';
import { render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANNOUNCE_IMMEDIATE_MS,
  ANNOUNCE_THROTTLE_MS,
  resetAnnouncer,
} from './announcer';
import {
  useListChangeAnnouncement,
  type ListChangeAnnouncement,
} from './useListChangeAnnouncement';

const TASKS: ListChangeAnnouncement = {
  channel: 'tasks',
  added: 'announce.tasksAdded',
  removed: 'announce.tasksCompleted',
};

const Probe = ({
  ids,
  options = TASKS,
}: {
  readonly ids: readonly string[] | undefined;
  readonly options?: ListChangeAnnouncement;
}) => {
  useListChangeAnnouncement(ids, options);
  return <p>Tasks</p>;
};

/**
 * `StrictMode` is not decoration. It invokes every effect twice on mount, which
 * is how the real application behaves and how a hook that guarded on "have I
 * run?" would announce something it should have suppressed.
 */
const renderProbe = (
  ids: readonly string[] | undefined,
  options: ListChangeAnnouncement = TASKS,
) => {
  const { rerender } = render(
    <StrictMode>
      <Probe ids={ids} options={options} />
    </StrictMode>,
  );
  return (
    next: readonly string[] | undefined,
    nextOptions: ListChangeAnnouncement = options,
  ) =>
    rerender(
      <StrictMode>
        <Probe ids={next} options={nextOptions} />
      </StrictMode>,
    );
};

const listen = async () => {
  await virtual.start({ container: document.body });
  await virtual.clearSpokenPhraseLog();
};

/** Long enough for any open announcement window to have flushed. */
const settle = () => vi.advanceTimersByTimeAsync(ANNOUNCE_THROTTLE_MS * 2);

describe('useListChangeAnnouncement', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(async () => {
    await virtual.stop();
    resetAnnouncer();
    vi.useRealTimers();
  });

  it('says nothing about the list it arrived to', async () => {
    await listen();
    renderProbe(['task-1', 'task-2', 'task-3']);

    await settle();

    // Three tasks already in flight is one page load, not three events. The
    // completion of that load is `useLoadingAnnouncement`'s to announce.
    expect(await virtual.spokenPhraseLog()).toEqual([]);
  });

  it('combines a burst of additions into one phrase carrying the count', async () => {
    await listen();
    const rerender = renderProbe(['task-1']);

    rerender(['task-1', 'task-2', 'task-3', 'task-4']);
    await settle();

    // Three separate `announce` calls, one sentence. This is the whole point
    // of ADR-027's coalescing, and the reason the wording carries `{count}`
    // rather than the caller counting.
    expect(await virtual.spokenPhraseLog()).toEqual(['polite: Tasks: 3 added']);
  });

  it('announces additions and removals as one sentence', async () => {
    await listen();
    const rerender = renderProbe(['task-1', 'task-2']);

    rerender(['task-2', 'task-3', 'task-4']);
    await settle();

    expect(await virtual.spokenPhraseLog()).toEqual([
      'polite: Tasks: 2 added, 1 completed',
    ]);
  });

  it('says nothing about a removal when the list has no wording for one', async () => {
    await listen();
    const rerender = renderProbe(['enquiry-1'], {
      channel: 'enquiry',
      added: 'announce.enquiryNew',
    });

    rerender([]);
    await settle();

    // An enquiry leaving the list means somebody answered it. That is not news
    // to the person who did, and there is nobody else it needs telling.
    expect(await virtual.spokenPhraseLog()).toEqual([]);
  });

  it('honours a throttle override, so an enquiry does not wait on a list window', async () => {
    await listen();
    const rerender = renderProbe([], {
      channel: 'enquiry',
      added: 'announce.enquiryNew',
      throttleMs: ANNOUNCE_IMMEDIATE_MS,
    });

    rerender(['enquiry-1']);
    // Deliberately far shorter than the default interval: a request for the
    // user to act must not sit behind ten seconds of list chatter.
    await vi.advanceTimersByTimeAsync(1);

    expect(await virtual.spokenPhraseLog()).toEqual([
      'polite: New enquiries: 1',
    ]);
  });

  it('reseeds silently when the reset key changes', async () => {
    await listen();
    const filtered: ListChangeAnnouncement = { ...TASKS, resetKey: 'active' };
    const rerender = renderProbe(['task-1', 'task-2'], filtered);

    // The user narrows the filter: eleven rows become one. They did it, they
    // are looking at it, and describing their own keystroke back to them is
    // the noise ADR-027's curation exists to prevent.
    rerender(['task-9'], { ...TASKS, resetKey: 'succeeded' });
    await settle();

    expect(await virtual.spokenPhraseLog()).toEqual([]);
  });

  it('resumes announcing against the new selection after a reseed', async () => {
    await listen();
    const rerender = renderProbe(['task-1'], { ...TASKS, resetKey: 'active' });

    rerender(['task-9'], { ...TASKS, resetKey: 'succeeded' });
    rerender(['task-9', 'task-10'], { ...TASKS, resetKey: 'succeeded' });
    await settle();

    // The reseed suppresses the filter change itself, not everything after it.
    expect(await virtual.spokenPhraseLog()).toEqual(['polite: Tasks: 1 added']);
  });

  it('says nothing while the list has not loaded, and nothing when it fails', async () => {
    await listen();
    const rerender = renderProbe(undefined);

    rerender(undefined);
    await settle();

    // `undefined` is "no answer yet", never "everything left". Treating it as
    // an emptying would announce a failed request as a list of completions.
    expect(await virtual.spokenPhraseLog()).toEqual([]);
  });

  it('treats the first loaded value as the baseline, however late it arrives', async () => {
    await listen();
    const rerender = renderProbe(undefined);

    rerender(['task-1', 'task-2']);
    await settle();

    expect(await virtual.spokenPhraseLog()).toEqual([]);
  });

  it('announces once under StrictMode, not twice', async () => {
    await listen();
    const rerender = renderProbe(['task-1']);

    rerender(['task-1', 'task-2']);
    await settle();

    // The announcer counts repeats rather than de-duplicating them, so a
    // double-invoked effect says "2 added" — the wrong number from the right
    // code. Nothing here is guarded on having run; the effect records what it
    // saw before announcing, so the second invocation finds no difference.
    expect(await virtual.spokenPhraseLog()).toEqual(['polite: Tasks: 1 added']);
  });

  it('stays silent when a re-render leaves membership unchanged', async () => {
    await listen();
    const rerender = renderProbe(['task-1', 'task-2']);

    // A status change patches rows in place without changing who is in the
    // list — the commonest event on this stream, and it must be silent.
    rerender(['task-1', 'task-2']);
    rerender(['task-1', 'task-2']);
    await settle();

    expect(await virtual.spokenPhraseLog()).toEqual([]);
  });
});
