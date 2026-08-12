import type { WireEvent } from '@tcp/shared/client';

import type { ApiError } from '../api/errors';

import { connect, type Connection } from './connect';

/**
 * The most streams that may be open at once.
 *
 * ponytail: a constant, not configuration. Twice the six-per-origin ceiling
 * HTTP/1.1 imposes, which is enough for a live view plus several dialogs. Raise
 * it deliberately when a real view is refused — the refusal is loud precisely
 * so that decision gets taken rather than drifted past.
 *
 * **The connection budget, decided in 008.02 and applied by everything after
 * it** (also recorded as an amendment to ADR-025, so either place finds it):
 *
 * 1. **One stream per mounted transcript, and nothing else opens a stream.** A
 *    page owns at most one — `CompanyPage` and its company stream. A dialog
 *    owns one per visible conversation or panel. No hook opens a stream
 *    (ADR-030). There is no per-surface quota: a second cap would have to be
 *    kept in step with this one, for no benefit.
 * 2. **A parked stream releases its connection.** Parked means unmounted: a
 *    minimised chat dialog, a collapsed assignment panel. Nothing holds a
 *    connection open for a surface the user cannot see.
 * 3. **A restored one catches up by re-priming, not by replay.** Remounting
 *    refetches the agent's history, rebuilds the transcript from it, and only
 *    then subscribes; the server synthesises a terminal event for a late
 *    subscriber. Token deltas from while it was parked are lost, and that is
 *    correct — they were never persisted, and the completed response is in the
 *    history.
 * 4. **Twelve still stands.** 005.02 picked the number before any view opened
 *    more than one stream and asked for it to be rechecked here. With rule 2 in
 *    force the realistic worst case is one company stream plus a handful of
 *    open panels, so reaching twelve means a fan-out bug — which is what the
 *    cap is for. HTTP/2 is mandatory (ADR-029), so the browser's own
 *    six-per-origin HTTP/1.1 ceiling does not bind.
 */
export const MAX_STREAMS = 12;

/** The event-stream endpoints, so callers don't hand-build paths. */
export const streamUrls = {
  company: (id: string) => `/api/company/${id}/events`,
  task: (id: string) => `/api/task/${id}/events`,
  agent: (id: string) => `/api/agent/${id}/events`,
};

type Listener = (event: WireEvent) => void;
type ErrorListener = (error: ApiError) => void;

interface Stream {
  connection: Connection;
  listeners: Set<Listener>;
  errors: Set<ErrorListener>;
}

const streams = new Map<string, Stream>();

/**
 * Subscribes to an event stream, opening a connection on the first subscriber
 * and closing it after the last. Several components watching the same thing
 * share one connection rather than opening one each.
 *
 * Returns the unsubscribe function. Calling it more than once is a no-op — React
 * StrictMode double-invokes effects, so an unsubscribe that ran twice would
 * otherwise tear down the connection its own remount had just reopened.
 *
 * @throws if opening a new stream would exceed {@link MAX_STREAMS}. An
 * unexpected fan-out has to fail visibly; the alternative is the browser
 * queuing connections silently and the view simply never updating.
 */
export const subscribe = (
  url: string,
  onEvent: Listener,
  onError: ErrorListener,
): (() => void) => {
  let stream = streams.get(url);

  if (!stream) {
    if (streams.size >= MAX_STREAMS) {
      const message =
        `Refusing to open event stream ${url}: ` +
        `${String(MAX_STREAMS)} streams are already open (MAX_STREAMS). ` +
        `This is a fan-out bug, not a limit to work around.`;
      console.error(message);
      throw new Error(message);
    }

    const listeners = new Set<Listener>();
    const errors = new Set<ErrorListener>();
    stream = {
      listeners,
      errors,
      connection: connect(
        url,
        (event) => {
          for (const listener of listeners) listener(event);
        },
        (error) => {
          for (const listener of errors) listener(error);
        },
      ),
    };
    streams.set(url, stream);
  }

  stream.listeners.add(onEvent);
  stream.errors.add(onError);

  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;

    // Re-read rather than closing over `stream`: this subscriber's own entry
    // may already have been closed and a later subscriber opened a fresh one
    // under the same url, and closing that one would be a silent regression.
    const current = streams.get(url);
    if (!current) return;
    current.listeners.delete(onEvent);
    current.errors.delete(onError);
    if (current.listeners.size > 0) return;
    current.connection.close();
    streams.delete(url);
  };
};

/** Open stream count, for tests and diagnostics. */
export const openStreamCount = (): number => streams.size;
