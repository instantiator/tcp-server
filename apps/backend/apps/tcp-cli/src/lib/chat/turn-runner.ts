// Running one agent turn end to end: open the event stream, post the message,
// render whatever comes back, and resolve the turn's outcome. Also owns the
// in-flight turn bookkeeping, since a turn's abort signal is the only handle
// anyone has on a running turn.

import { TokenManager } from '../auth/token';
import { createRenderer, Renderer } from '../core/render';
import { parseWireEvents } from '../core/sse';
import { failedWire } from '../render/audit-wire';
import { Tui } from '../tui/tui';
import { tuiRenderer } from '../tui/tui-renderer';
import { str } from './wire-parse';

/** Result of watching one agent's turn to its terminal event. */
type TurnOutcome = { response: string } | { error: string };

/** Sentinel error signalling the SSE stream ended before a terminal event. */
const STREAM_ENDED = 'stream ended before completion';

/** How long a single turn may run before its signal aborts it. */
const TURN_TIMEOUT_MS = 35 * 60 * 1000;

/** Gap between polls of the agent record when the SSE stream drops mid-turn. */
const POLL_INTERVAL_MS = 2000;

/** Resolves after `ms`, or immediately if the signal aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Runs turns on behalf of a {@link ChatSession}, one per pane.
 *
 * NB. multiple panes can each have a turn in flight concurrently — every piece
 * of state here is keyed by pane (== agent) id.
 */
export class TurnRunner {
  /** In-flight turns keyed by pane (== agent) id; empty when idle. */
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(
    private readonly tokens: TokenManager,
    private readonly baseUrl: string,
    private readonly tui: Tui | null,
    private readonly hideReasoning: boolean,
  ) {}

  /** Whether any pane has a turn in flight. */
  get hasInFlightTurns(): boolean {
    return this.abortControllers.size > 0;
  }

  /** Whether `paneId` specifically has a turn in flight. */
  isBusy(paneId: string): boolean {
    return this.abortControllers.has(paneId);
  }

  /** Aborts every in-flight turn (the agents continue running server-side). */
  abortAll(): void {
    for (const controller of this.abortControllers.values()) controller.abort();
    this.abortControllers.clear();
  }

  /** Aborts one pane's turn, if it has one in flight. */
  abort(paneId: string): void {
    const controller = this.abortControllers.get(paneId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(paneId);
    }
  }

  /**
   * Runs one turn on `paneId`'s agent: opens the event stream, posts the
   * message, waits for the terminal event, then prints the final response.
   *
   * `interactive` is only ever false for a `--query` turn with no TUI (piped
   * output, or `--no-tui`): progress streams to stderr and the final answer
   * prints to stdout once, keeping it pipeable. Every other case — normal
   * interactive turns, and `--query` turns once a TUI is involved — passes
   * `interactive: true`, so the response renders into the pane like any other
   * turn instead of being printed and torn down.
   */
  async runTurn(
    paneId: string,
    message: string,
    interactive: boolean,
  ): Promise<void> {
    const abort = new AbortController();
    this.abortControllers.set(paneId, abort);
    // Typing stays possible while the turn runs, but Enter won't submit
    // until it finishes (the hint row explains why, on this pane).
    this.tui?.setBusy(paneId, true);
    const signal = AbortSignal.any([
      abort.signal,
      AbortSignal.timeout(TURN_TIMEOUT_MS),
    ]);
    const renderer = this.tui
      ? tuiRenderer(this.tui, paneId)
      : createRenderer({
          hideReasoning: this.hideReasoning,
          out: interactive ? process.stdout : process.stderr,
          err: process.stderr,
        });
    try {
      // Open the stream before posting so early events aren't missed; the
      // server also replays the terminal event to late subscribers.
      let markConnected!: () => void;
      const connected = new Promise<void>((r) => (markConnected = r));
      const streamPromise = this.streamAgent(
        paneId,
        renderer,
        signal,
        markConnected,
      );
      await connected;
      // No local echo — the typed message renders from its `input` audit event
      // as it arrives over the stream (decision 1).
      await this.postMessage(paneId, message, signal);

      let outcome = await streamPromise;
      if (
        'error' in outcome &&
        outcome.error === STREAM_ENDED &&
        !abort.signal.aborted
      ) {
        outcome = await this.pollForCompletion(paneId, signal);
      }

      if (abort.signal.aborted) return;
      this.reportOutcome(paneId, outcome, renderer, interactive);
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      if (this.tui) {
        this.tui.appendEvent(paneId, failedWire(message));
      } else {
        process.stderr.write(`\nError: ${message}\n`);
      }
    } finally {
      this.abortControllers.delete(paneId);
      this.tui?.setBusy(paneId, false);
    }
  }

  /**
   * Renders a finished turn's outcome, wherever it belongs.
   *
   * A non-interactive turn's answer goes to stdout so it stays pipeable; an
   * interactive one only needs writing when the stream never carried the
   * response itself.
   */
  private reportOutcome(
    paneId: string,
    outcome: TurnOutcome,
    renderer: Renderer,
    interactive: boolean,
  ): void {
    if ('response' in outcome) {
      if (!interactive) {
        // Tear the TUI down before writing the final answer — it must
        // land in normal scrollback, not the (about to vanish) alt screen.
        this.tui?.stop();
        process.stdout.write(outcome.response + '\n');
      } else if (!renderer.responseSeen) {
        if (this.tui) {
          this.tui.appendEvent(paneId, {
            type: 'stream',
            agentId: paneId,
            channel: 'response',
            delta: outcome.response,
            timestamp: new Date().toISOString(),
          });
        } else {
          const text = outcome.response.trim() ? outcome.response : '(blank)';
          process.stdout.write(`\nResponse: ${text}\n`);
        }
      }
      return;
    }
    if (outcome.error === STREAM_ENDED) return;
    if (this.tui) {
      this.tui.appendEvent(paneId, failedWire(outcome.error));
    } else {
      process.stderr.write(`\n[Error] ${outcome.error}\n`);
    }
  }

  /**
   * Opens the SSE stream for `id`, rendering each event until the agent's
   * terminal (`completed`/`failed`) event arrives.
   *
   * When the agent pauses to consult another agent, spawns a follower stream
   * for that agent, prefixed with its role name.
   *
   * NB. resolves with a {@link STREAM_ENDED} error if the stream closes with no
   * terminal event.
   */
  private async streamAgent(
    id: string,
    renderer: Renderer,
    signal: AbortSignal,
    onConnected?: () => void,
  ): Promise<TurnOutcome> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/api/agent/${id}/events`;
    const followerAbort = new AbortController();
    const followers: Promise<unknown>[] = [];
    let outcome: TurnOutcome | undefined;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.tokens.current}` },
        signal,
      });
      onConnected?.();
      if (!res.ok || !res.body) {
        return { error: `events stream failed with HTTP ${res.status}` };
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!outcome) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = parseWireEvents(buffer);
        buffer = rest;
        for (const wire of events) {
          const agentState =
            wire.type === 'audit' &&
            wire.event.eventType === 'state_change' &&
            wire.event.payload['entity'] === 'agent'
              ? wire.event.payload
              : undefined;
          if (agentState) {
            const status = str(agentState, 'newStatus');
            // A consultation pause: render the line, then follow the consulted
            // agent (keyed on `consultedAgentId`) — not terminal.
            if (agentState['reason'] === 'consultation') {
              renderer.render(wire);
              this.followConsultation(
                str(agentState, 'consultedAgentId'),
                str(agentState, 'consultedRoleName'),
                followerAbort.signal,
                followers,
              );
              continue;
            }
            // The server synthesizes this for a late subscriber reconnecting
            // to an already-finished turn — but this stream always connects
            // *before* posting the message (to not miss early events), so at
            // connect time the agent is always still idle from its *previous*
            // turn (or never having run at all). Treating that as this turn's
            // own completion made every turn terminate instantly with an
            // empty response, before the real events ever arrived. Not
            // terminal, and not worth rendering — it describes stale state.
            if (agentState['reason'] === 'replay') {
              continue;
            }
            if (status === 'completed' || status === 'idle') {
              outcome = { response: str(agentState, 'response') };
              break;
            }
            if (status === 'failed' || status === 'cancelled') {
              outcome = { error: str(agentState, 'reason') };
              break;
            }
          }
          renderer.render(wire);
        }
      }
    } catch (err) {
      onConnected?.();
      if (err instanceof Error && err.name === 'AbortError') {
        return { error: STREAM_ENDED };
      }
      return {
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      renderer.finish();
      followerAbort.abort();
      await Promise.allSettled(followers);
    }
    return outcome ?? { error: STREAM_ENDED };
  }

  /**
   * Spawns a follower stream for a consulted agent — a new pane (TUI) or a
   * stderr renderer (piped) — and queues it in `followers`. No-op without a
   * `consultId`.
   */
  private followConsultation(
    consultId: string,
    consultRoleName: string,
    signal: AbortSignal,
    followers: Promise<unknown>[],
  ): void {
    if (!consultId) return;
    let follower: Renderer;
    if (this.tui) {
      this.tui.addPane({
        id: consultId,
        label: consultRoleName,
        talkable: false,
      });
      follower = tuiRenderer(this.tui, consultId);
    } else {
      follower = createRenderer({
        hideReasoning: this.hideReasoning,
        out: process.stderr,
        err: process.stderr,
      });
    }
    followers.push(
      this.streamAgent(consultId, follower, signal).catch(() => undefined),
    );
  }

  /** POSTs a message to `paneId`'s agent (expects 202); {@link TokenManager.request} handles a 401 by refreshing and retrying. */
  private async postMessage(
    paneId: string,
    message: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.tokens.request<{ accepted: boolean }>(
      'POST',
      `/api/agent/${paneId}/message`,
      { message },
      signal,
    );
  }

  /**
   * Fallback when the SSE stream drops mid-turn: polls the agent record until
   * it reaches a terminal (or idle-after-run) state.
   */
  private async pollForCompletion(
    id: string,
    signal: AbortSignal,
  ): Promise<TurnOutcome> {
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    while (!signal.aborted && Date.now() < deadline) {
      await delay(POLL_INTERVAL_MS, signal);
      if (signal.aborted) break;
      try {
        const agent = await this.tokens.request<{
          status: string;
          output?: string;
        }>('GET', `/api/agent/${id}`, undefined, signal);
        if (agent.status === 'completed' || agent.status === 'idle') {
          return { response: agent.output ?? '' };
        }
        if (agent.status === 'failed') {
          return { error: agent.output ?? 'agent failed' };
        }
      } catch {
        // transient error — keep polling
      }
    }
    return { error: 'timed out waiting for completion' };
  }
}
