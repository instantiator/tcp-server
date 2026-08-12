import { readWireStream, type WireEvent } from '@tcp/shared/client';

import { ApiError } from '../api/errors';
import { getAccessToken } from '../auth/access-token';
import { handleUnauthorized } from '../auth/unauthorized';

/** First retry delay, before jitter. */
const RETRY_BASE_MS = 1000;

/** Ceiling on the retry delay, before jitter. */
const RETRY_CAP_MS = 30_000;

/** A live event stream that keeps itself connected until it is closed. */
export interface Connection {
  /** Stops reading and abandons any pending retry. Safe to call twice. */
  close: () => void;
}

/**
 * What can make a paused connection worth retrying immediately, each paired
 * with the target that fires it — `visibilitychange` is dispatched at the
 * document, not the window.
 */
const RESUME_TRIGGERS: readonly [EventTarget, string][] = [
  [window, 'online'],
  [document, 'visibilitychange'],
];

/** Runs `listener` on every resume trigger, returning a one-shot detach. */
const onResumeTrigger = (listener: () => void): (() => void) => {
  for (const [target, name] of RESUME_TRIGGERS)
    target.addEventListener(name, listener);
  return () => {
    for (const [target, name] of RESUME_TRIGGERS)
      target.removeEventListener(name, listener);
  };
};

/** Whether the browser is in a state where a connection attempt makes sense. */
const resumable = (): boolean => navigator.onLine && !document.hidden;

/**
 * Resolves once the browser is online and the page is visible, immediately if
 * it already is. Retrying into a sleeping tab or a lost network burns attempts
 * and inflates the backoff, so the wait replaces those attempts rather than
 * counting as one.
 */
const whenResumable = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted || resumable()) {
      resolve();
      return;
    }
    const done = () => {
      // `visibilitychange` also fires on the way *into* hidden, so re-check
      // rather than treating any trigger as a resume.
      if (!signal.aborted && !resumable()) return;
      detach();
      signal.removeEventListener('abort', done);
      resolve();
    };
    const detach = onResumeTrigger(done);
    signal.addEventListener('abort', done);
  });

/**
 * Waits `ms`, but gives up early when the connection closes or when the browser
 * comes back online or visible — so a tab the user returns to reconnects at
 * once instead of sitting out the rest of a capped 30-second delay.
 */
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      detach();
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const detach = onResumeTrigger(done);
    signal.addEventListener('abort', done);
  });

/** Exponential backoff with full jitter, so reconnects don't arrive in lockstep. */
const backoffFor = (attempt: number): number =>
  Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt) *
  (0.5 + Math.random() * 0.5);

/** Wording for a refusal the backoff must not retry, so the reason is legible. */
const refusalMessage = (status: number, url: string): string =>
  status === 403
    ? `Not permitted to read the event stream at ${url}`
    : `The event stream at ${url} was refused with HTTP ${String(status)}`;

/**
 * Reads an event stream and keeps reading it, reconnecting through drops with
 * exponential backoff until {@link Connection.close} is called.
 *
 * `onError` receives permanent refusals only — a `401`, or any other `4xx` such
 * as the `403` a non-member gets at connect. Transient failures (a network
 * blip, a `5xx`, a server-closed stream) are retried silently, which is what
 * the backoff exists for; surfacing those would put an error in front of the
 * user for something that fixes itself.
 *
 * State is not carried across a reconnect. Recovery comes from the server: the
 * company and task streams prime with current state on subscribe and the agent
 * endpoint synthesises a terminal event for late subscribers, so a reconnected
 * stream re-renders correctly on its own (ADR-025). That coupling is
 * load-bearing here.
 */
export const connect = (
  url: string,
  onEvent: (event: WireEvent) => void,
  onError: (error: ApiError) => void,
): Connection => {
  const controller = new AbortController();
  const { signal } = controller;

  const run = async (): Promise<void> => {
    let attempt = 0;

    while (!signal.aborted) {
      await whenResumable(signal);
      if (signal.aborted) return;

      // Fetched inside the loop, on every attempt including each reconnect. A
      // token captured when the connection was created works for hours and
      // then fails permanently at the first blip after it expires, because
      // every retry re-presents the same dead credential (ADR-024).
      const token = await getAccessToken();
      if (signal.aborted) return;
      if (token === null) {
        // No live session to renew from, so the redirect is the renewal. Not
        // awaited, and nothing is retried after it.
        void handleUnauthorized();
        return;
      }

      const end = await readWireStream(url, token, signal, onEvent, () => {
        attempt = 0;
      });

      if (end.reason === 'aborted' || signal.aborted) return;

      if (end.reason === 'failed' && end.status >= 400 && end.status < 500) {
        // The same deduplicated, full-page policy the fetch wrapper uses, so a
        // token that has genuinely gone produces one navigation whether a
        // request or a stream noticed first.
        if (end.status === 401) void handleUnauthorized();
        // No body: an SSE refusal is rejected before the stream opens, so there
        // is nothing read back to attach.
        onError(
          new ApiError(end.status, refusalMessage(end.status, url), undefined),
        );
        return;
      }

      await sleep(backoffFor(attempt), signal);
      attempt += 1;
    }
  };

  void run();

  return { close: () => controller.abort() };
};
