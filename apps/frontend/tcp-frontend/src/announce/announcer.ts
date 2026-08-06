import { announce as speak, clearAnnouncer } from '@react-aria/live-announcer';
import { t, type StringKey, type StringParams } from '../strings';

/**
 * The application's one announcer. Everything a screen reader is told, it is
 * told from here (ADR-027).
 *
 * **No component may render a live region.** A region mounted at the same
 * moment as its content announces all of it, or none of it; several regions
 * updating together produce interleaved, unreadable output. Both failures are
 * why this module exists, and neither is visible in a component test that only
 * asserts on markup — so a component that mounts its own region will look
 * correct right up until someone listens to it.
 *
 * Three things callers depend on:
 *
 * - **It counts repeats; it does not de-duplicate.** Two identical calls mean
 *   two things happened, and are announced as two. That makes `StrictMode`
 *   safety the *caller's* job: guard your effect on the value that changed,
 *   never on whether the effect has run, because `StrictMode` invokes it twice
 *   on mount and a boolean flag is spent by the first invocation.
 * - **A channel's interval is set by the announcement that opens its window.**
 *   Later announcements in the same window join it; they do not shorten it. A
 *   channel belongs to one surface, so one writer sets the pace.
 * - **Announce what changed, not the new state.** "Tasks: 2 added" is useful;
 *   re-reading the whole list is not.
 *
 * There is no context and no provider. ADR-027 asks for a single
 * application-level announcer, and a module singleton is that more literally
 * than a provider is: it matches react-aria's own model, gives `announce` a
 * stable identity so it never has to appear in a dependency array, and needs
 * no place in the provider stack to be reachable from anywhere.
 */

/** ADR-027's starting point: ~10 seconds, tuned during the manual pass. */
export const ANNOUNCE_THROTTLE_MS = 10_000;

/** For announcements that must not wait: a route change, a failure. */
export const ANNOUNCE_IMMEDIATE_MS = 0;

/** ADR-027: a wait shorter than this is not worth mentioning. */
export const ANNOUNCE_LOADING_MIN_MS = 1_000;

/** Whether an announcement waits its turn or interrupts what is being read. */
export type Politeness = 'polite' | 'assertive';

export interface Announcement {
  /**
   * Changes sharing a channel coalesce into one phrase. One surface, one
   * channel — two writers on one channel would race for the interval.
   */
  readonly channel: string;
  /** What changed. Never the whole new state. */
  readonly change: StringKey;
  /** Values for `change`'s slots. `{count}` is supplied by the announcer. */
  readonly params?: StringParams;
  /** Defaults to `polite`. Only a failure needing action interrupts. */
  readonly politeness?: Politeness;
  /**
   * How long to accumulate before speaking. Defaults to
   * {@link ANNOUNCE_THROTTLE_MS} when polite and {@link ANNOUNCE_IMMEDIATE_MS}
   * when assertive.
   */
  readonly throttleMs?: number;
}

interface Change {
  readonly change: StringKey;
  readonly params?: StringParams;
  count: number;
}

interface Window {
  readonly politeness: Politeness;
  /** Distinct changes in announcement order, each with how often it happened. */
  readonly changes: Map<string, Change>;
  readonly timer: ReturnType<typeof setTimeout>;
}

// Keyed by politeness and channel together: a polite and an assertive
// announcement about the same surface are different sentences, spoken into
// different regions, and must not be coalesced into one.
const windows = new Map<string, Window>();

// Creates both live regions now, empty. A region that appears at the same
// moment as its content is announced by nothing (ADR-027); react-aria delays
// its own *first* message by 100ms for exactly that reason, so priming means
// no real announcement ever depends on that delay. The clear then removes the
// empty node the priming call appended — react-aria skips its removal timer
// for an empty message, so it would otherwise sit in the log forever.
speak('', 'polite');
clearAnnouncer('polite');

/**
 * Coalesces the changes accumulated on a channel into one phrase and speaks it.
 */
const flush = (key: string): void => {
  const window = windows.get(key);
  if (window === undefined) return;
  windows.delete(key);

  const phrase = [...window.changes.values()]
    .map(({ change, params, count }) => t(change, { ...params, count }))
    .join(t('announce.separator'));

  speak(phrase, window.politeness);
};

/**
 * Asks the announcer to say that something changed.
 *
 * Nothing is spoken immediately: the change joins its channel's open window,
 * or opens one, and the whole window is spoken as a single phrase when the
 * interval elapses. Under a burst the user hears one sentence, not six.
 */
export const announce = ({
  channel,
  change,
  params,
  politeness = 'polite',
  throttleMs,
}: Announcement): void => {
  const key = `${politeness}:${channel}`;
  // Params are identified by their serialisation, so "2 tasks added" and
  // "1 enquiry added" stay separate clauses while two identical changes
  // become a count. Key order is therefore significant; every call site
  // passes an object literal, so in practice it is stable.
  const changeKey = `${change}:${JSON.stringify(params ?? null)}`;

  const open = windows.get(key);
  if (open !== undefined) {
    const seen = open.changes.get(changeKey);
    if (seen === undefined) {
      open.changes.set(changeKey, { change, params, count: 1 });
    } else {
      seen.count += 1;
    }
    return;
  }

  const interval =
    throttleMs ??
    (politeness === 'assertive' ? ANNOUNCE_IMMEDIATE_MS : ANNOUNCE_THROTTLE_MS);

  windows.set(key, {
    politeness,
    changes: new Map([[changeKey, { change, params, count: 1 }]]),
    // Always a timer, even at zero: an announcement made while React is
    // rendering must not reach the DOM inside that render, and a zero-delay
    // timer also gives everything else in the same tick a chance to join the
    // window — which is what makes two simultaneous failures one sentence.
    timer: setTimeout(() => {
      flush(key);
    }, interval),
  });
};

/**
 * Test-only. Drops every pending announcement and empties both regions.
 *
 * The announcer is a module singleton whose regions live in `document.body`,
 * which Testing Library's `cleanup()` does not touch, so without this one
 * test's announcements appear in the next test's spoken phrase log.
 *
 * This clears the regions rather than destroying them, so the next test still
 * starts with regions that existed before their content did.
 */
export const resetAnnouncer = (): void => {
  for (const { timer } of windows.values()) clearTimeout(timer);
  windows.clear();
  // Both, named explicitly: the runtime clears everything when the argument
  // is omitted, but the published type declares it required.
  clearAnnouncer('polite');
  clearAnnouncer('assertive');
};
