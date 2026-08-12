// The ADR-027 gate. Every rule that ADR exists to enforce — never a flood,
// one phrase per interval per channel, what changed rather than the new state,
// the right politeness per surface — is asserted here, against the real
// announcer, through a screen reader simulator rather than through the DOM.
//
// `spokenPhraseLog()` is what makes that possible: it is the ordered sequence
// of everything a screen reader would say. A test asserting it holds one
// coalesced phrase, and not fifty per-change entries, encodes the rule
// directly rather than approximating it.
import { virtual } from '@guidepup/virtual-screen-reader';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANNOUNCE_IMMEDIATE_MS,
  ANNOUNCE_THROTTLE_MS,
  announce,
  resetAnnouncer,
} from './announcer';
import { t } from '../strings';

/** Runs a channel's window to completion, with room to spare. */
const advancePastThrottle = () =>
  vi.advanceTimersByTimeAsync(ANNOUNCE_THROTTLE_MS * 2);

/** Starts the simulator and drops the phrase `start()` emits for the container. */
const listen = async () => {
  await virtual.start({ container: document.body });
  await virtual.clearSpokenPhraseLog();
};

describe('the application announcer', () => {
  beforeEach(() => {
    // shouldAdvanceTime keeps real time moving underneath the fake clock, so
    // the simulator's own awaits still settle while the throttle is driven
    // deterministically (ADR-027's amendment).
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(async () => {
    await virtual.stop();
    vi.useRealTimers();
  });

  it('announces nothing until something changes', async () => {
    await listen();
    await advancePastThrottle();

    // Both regions are created when this module is imported, so that no
    // announcement has to race their arrival. Creating them must be silent.
    expect(await virtual.spokenPhraseLog()).toEqual([]);
  });

  it('combines several changes in one channel into a single phrase', async () => {
    await listen();

    announce({ channel: 'tasks', change: 'announce.tasksAdded' });
    announce({ channel: 'tasks', change: 'announce.tasksAdded' });
    announce({ channel: 'tasks', change: 'announce.tasksCompleted' });
    await advancePastThrottle();

    // ADR-027's own worked example, including the politeness prefix.
    expect(await virtual.spokenPhraseLog()).toEqual([
      'polite: Tasks: 2 added, 1 completed',
    ]);
  });

  it('does not flood under a burst of rapid updates', async () => {
    await listen();

    // A task fanning out to fifty assignments, arriving over a couple of
    // seconds — comfortably inside one window.
    for (let i = 0; i < 50; i++) {
      announce({ channel: 'tasks', change: 'announce.tasksAdded' });
      await vi.advanceTimersByTimeAsync(50);
    }
    await advancePastThrottle();

    // The count matters as much as the length: fifty separate clauses in one
    // utterance would satisfy "one announcement" and still be a flood.
    expect(await virtual.spokenPhraseLog()).toEqual([
      'polite: Tasks: 50 added',
    ]);
  });

  it('speaks at most once per interval', async () => {
    await listen();

    announce({ channel: 'tasks', change: 'announce.tasksAdded' });
    announce({ channel: 'tasks', change: 'announce.tasksAdded' });
    await advancePastThrottle();

    announce({ channel: 'tasks', change: 'announce.tasksAdded' });
    await advancePastThrottle();

    // Two windows, two phrases — not three announcements for three changes.
    expect(await virtual.spokenPhraseLog()).toEqual([
      'polite: Tasks: 2 added',
      'polite: Tasks: 1 added',
    ]);
  });

  it('says nothing when nothing changed', async () => {
    await listen();

    await advancePastThrottle();
    await advancePastThrottle();
    await advancePastThrottle();

    expect(await virtual.spokenPhraseLog()).toEqual([]);
  });

  it('keeps channels apart', async () => {
    await listen();

    announce({ channel: 'tasks', change: 'announce.tasksAdded' });
    announce({ channel: 'enquiries', change: 'announce.tasksCompleted' });
    await advancePastThrottle();

    // Two surfaces changing together are two sentences. Merging them would
    // produce a phrase that describes neither list.
    const spoken = await virtual.spokenPhraseLog();
    expect(spoken).toHaveLength(2);
    expect(spoken).toContain('polite: Tasks: 1 added');
    expect(spoken).toContain('polite: 1 completed');
  });

  it('interrupts for an assertive announcement and waits for a polite one', async () => {
    await listen();

    announce({
      channel: 'companies',
      change: 'state.error.announcement',
      params: { message: 'Companies could not be loaded' },
      politeness: 'assertive',
    });
    // Only long enough for the zero-delay window to close. A polite
    // announcement made now would still be waiting.
    await vi.advanceTimersByTimeAsync(1);

    expect(await virtual.spokenPhraseLog()).toEqual([
      'assertive: Error: Companies could not be loaded',
    ]);
  });

  it('coalesces assertive announcements too', async () => {
    await listen();

    // Two lists failing in the same tick is one failure to the user, and
    // must not be two interruptions.
    announce({
      channel: 'companies',
      change: 'state.error.announcement',
      params: { message: 'Companies could not be loaded' },
      politeness: 'assertive',
    });
    announce({
      channel: 'companies',
      change: 'state.error.announcement',
      params: { message: 'Companies could not be loaded' },
      politeness: 'assertive',
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(await virtual.spokenPhraseLog()).toHaveLength(1);
  });

  it('speaks a polite and an assertive change about one surface separately', async () => {
    await listen();

    announce({
      channel: 'tasks',
      change: 'announce.tasksAdded',
      throttleMs: ANNOUNCE_IMMEDIATE_MS,
    });
    announce({
      channel: 'tasks',
      change: 'state.error.announcement',
      params: { message: 'A task could not be started' },
      politeness: 'assertive',
    });
    await advancePastThrottle();

    // They go into different regions; coalescing them into one phrase would
    // put an interrupting message into the queue behind a waiting one.
    const spoken = await virtual.spokenPhraseLog();
    expect(spoken).toContain('polite: Tasks: 1 added');
    expect(spoken).toContain('assertive: Error: A task could not be started');
  });

  it('counts a genuine repeat rather than discarding it', async () => {
    await listen();

    // Two tasks really were added. The announcer cannot tell this from
    // StrictMode invoking a caller's effect twice, which is precisely why
    // callers guard on the value that changed rather than relying on this.
    announce({ channel: 'tasks', change: 'announce.tasksAdded' });
    announce({ channel: 'tasks', change: 'announce.tasksAdded' });
    await advancePastThrottle();

    expect(await virtual.spokenPhraseLog()).toEqual(['polite: Tasks: 2 added']);
  });

  it('keeps changes with different values as separate clauses', async () => {
    await listen();

    announce({
      channel: 'route',
      change: 'announce.routeChange',
      params: { title: 'Companies' },
      throttleMs: ANNOUNCE_IMMEDIATE_MS,
    });
    announce({
      channel: 'route',
      change: 'announce.routeChange',
      params: { title: 'Page not found' },
    });
    await advancePastThrottle();

    expect(await virtual.spokenPhraseLog()).toEqual([
      `polite: Companies${t('announce.separator')}Page not found`,
    ]);
  });

  it('drops pending announcements when reset', async () => {
    await listen();

    announce({ channel: 'tasks', change: 'announce.tasksAdded' });
    resetAnnouncer();
    await advancePastThrottle();

    // Without this, a pending window outlives the test that opened it and
    // fires into an unrelated one.
    expect(await virtual.spokenPhraseLog()).toEqual([]);
  });
});
