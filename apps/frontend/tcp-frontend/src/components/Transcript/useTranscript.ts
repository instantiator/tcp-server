import { useEffect, useRef, useState } from 'react';
import {
  EventLogBuffer,
  responseText,
  type AppendEvent,
  type AuditWireEvent,
  type LogEntry,
  type WireEvent,
} from '@tcp/shared/client';
import { announce } from '../../announce/announcer';
import { useAgentHistory } from '../../api/hooks';
import { ApiError } from '../../api/errors';
import { streamUrls } from '../../events/subscriptions';
import { useEventStream } from '../../events/useEventStream';

/**
 * Whether a completed response is announced in full, or only as having
 * arrived.
 *
 * ADR-027 leaves this open until the manual screen reader pass (001.02, phase 06). An
 * agent's answer can run to several paragraphs, and reading all of it holds
 * the audio channel for a long time with no useful way to interrupt — while
 * the text is on screen and browsable either way. So it is `false` for now,
 * and it is a constant rather than an inline choice so the pass can change it
 * here and nowhere else.
 *
 * Typed as `boolean` rather than left to infer `false`, so both branches stay
 * live code that the compiler checks.
 */
export const ANNOUNCE_RESPONSE_BODY: boolean = false;

/**
 * What a transcript is doing.
 *
 * `refused` and `at-capacity` are separated from `failed` because neither is
 * a fault the user can retry away: one is a permission answer and the other is
 * the connection budget. Rendering either as a spinner would wait forever.
 */
export type TranscriptStatus =
  'loading' | 'ready' | 'refused' | 'at-capacity' | 'failed';

export interface TranscriptState {
  readonly entries: readonly LogEntry[];
  readonly status: TranscriptStatus;
}

/** The audit event types that end a response, and so are worth announcing. */
const COMPLETION_EVENTS: ReadonlySet<string> = new Set([
  'llm_response',
  'agent_loop_completion',
]);

/**
 * Folds one incremental change from the buffer into the rendered entries.
 *
 * The entry is **copied** rather than kept by reference. {@link EventLogBuffer}
 * grows its own trailing entry in place as deltas arrive *and* emits each
 * delta; holding its object and also appending the delta text here would show
 * every token twice.
 */
const applyAppend = (
  entries: readonly LogEntry[],
  append: AppendEvent,
): readonly LogEntry[] => {
  switch (append.kind) {
    case 'entry':
      return [...entries, { ...append.entry }];
    case 'delta': {
      const last = entries.at(-1);
      if (last === undefined) return entries;
      return [
        ...entries.slice(0, -1),
        { ...last, text: last.text + append.delta },
      ];
    }
    case 'heading':
      // Headings are switched off below: one transcript shows one agent, and
      // the dialog around it already says whose it is.
      return entries;
  }
};

/** A permission answer or a budget refusal, told apart from an ordinary failure. */
const statusForStreamError = (error: Error): TranscriptStatus => {
  // `useEventStream` produces exactly two kinds of error: an `ApiError` from
  // the reader's permanent-refusal path, and a plain `Error` thrown by
  // `subscribe` when opening would exceed MAX_STREAMS.
  if (!(error instanceof ApiError)) return 'at-capacity';
  return error.status === 403 ? 'refused' : 'failed';
};

/**
 * One agent's event stream, as a readable conversation.
 *
 * History primes the transcript first, and only then does it subscribe: the
 * two sources cannot be interleaved correctly without buffering one of them,
 * and the cost of waiting is a short window in which a live event is missed.
 * The agent stream synthesises a terminal event for a late subscriber, which
 * covers the case that matters most.
 *
 * The stream goes through {@link useEventStream}, so it goes through the
 * subscription manager and counts against `MAX_STREAMS`. Token deltas live
 * here in component state and never reach the query cache (ADR-021) — a
 * transcript that unmounts loses them, and reopening re-primes from history.
 *
 * **Nothing is announced while a response streams.** Suppressing per-token
 * announcements is this hook's job, not the announcer's throttle: a token that
 * never calls `announce` costs nothing, whereas streaming tokens into the
 * announcer and relying on coalescing would still say something every ten
 * seconds mid-response. This is the single failure ADR-027 exists to prevent.
 *
 * @param agentId The agent whose work this shows.
 * @param roleName The agent's role, for the completion announcement.
 */
export const useTranscript = (
  agentId: string,
  roleName: string,
): TranscriptState => {
  const history = useAgentHistory(agentId);
  const [entries, setEntries] = useState<readonly LogEntry[]>([]);
  const bufferRef = useRef<EventLogBuffer | null>(null);

  // Keyed on which response was announced, not on whether this has announced
  // before: StrictMode invokes effects twice and the announcer counts repeats
  // rather than discarding them, so a run-count guard would speak twice.
  const lastAnnounced = useRef<string | null>(null);

  const historyRows = history.data;

  useEffect(() => {
    if (historyRows === undefined) return;

    const buffer = new EventLogBuffer(
      // No heading provider is ever called, because headings are off.
      () => ({}),
      false,
      false,
    );
    buffer.onAppend((append) => {
      setEntries((previous) => applyAppend(previous, append));
    });

    setEntries([]);
    for (const row of historyRows) buffer.appendAudit(row);
    bufferRef.current = buffer;

    return () => {
      bufferRef.current = null;
    };
  }, [agentId, historyRows]);

  const announceCompletion = (event: AuditWireEvent): void => {
    if (!COMPLETION_EVENTS.has(event.eventType)) return;

    const key = event.id ?? event.timestamp;
    if (lastAnnounced.current === key) return;
    lastAnnounced.current = key;

    announce({
      // Its own channel per agent, so two transcripts streaming at once are
      // two sentences rather than one describing neither.
      channel: `transcript:${agentId}`,
      change: ANNOUNCE_RESPONSE_BODY
        ? 'transcript.announce.responseBody'
        : 'transcript.announce.response',
      params: ANNOUNCE_RESPONSE_BODY
        ? { role: roleName, body: responseText(event.payload) }
        : { role: roleName },
      politeness: 'polite',
    });
  };

  const handleEvent = (event: WireEvent): void => {
    const buffer = bufferRef.current;
    if (buffer === null) return;

    if (event.type === 'stream') {
      // Deltas render as they arrive and announce nothing — see above.
      buffer.appendDelta(event);
      return;
    }
    buffer.appendAudit(event.event);
    announceCompletion(event.event);
  };

  const { error } = useEventStream(
    history.isSuccess ? streamUrls.agent(agentId) : null,
    handleEvent,
  );

  const status = ((): TranscriptStatus => {
    if (error !== null) return statusForStreamError(error);
    if (history.isError) {
      return history.error instanceof ApiError && history.error.status === 403
        ? 'refused'
        : 'failed';
    }
    return history.isSuccess ? 'ready' : 'loading';
  })();

  return { entries, status };
};
