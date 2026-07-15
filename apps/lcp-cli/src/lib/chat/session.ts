import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest, ApiOptions } from '../core/api';
import { renewToken } from '../auth/token';
import { createRenderer, Renderer } from '../core/render';
import { parseSseBuffer, SseEvent } from '../core/sse';
import { RoleOption, Tui, tuiRenderer } from '../tui/tui';

interface AgentRecord {
  id: string;
}

/** Result of watching one agent's turn to its terminal event. */
type TurnOutcome = { response: string } | { error: string };

/** Sentinel error signalling the SSE stream ended before a terminal event. */
const STREAM_ENDED = 'stream ended before completion';

/** Reads a string field from an SSE event's data payload. */
function eventStr(event: SseEvent, key: string): string {
  const value = event.data?.[key];
  return typeof value === 'string' ? value : '';
}

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
 * Owns one chat session's mutable state — the resolved token (renewed on
 * 401), every agent created (for cleanup), and each pane's in-flight turn —
 * and the operations that act on it: starting agent panes, running a turn
 * (post message → stream its events → resolve the outcome), and cleanup.
 *
 * Kept as a class (rather than closures, as before this file was split out)
 * because nearly every operation shares this same mutable state; the class
 * just gives that state a name instead of a chain of captured variables.
 */
export class ChatSession {
  private readonly agentIds = new Set<string>();
  /** In-flight turns keyed by pane (== agent) id; empty when idle. */
  private readonly abortControllers = new Map<string, AbortController>();
  private token: string;
  private readonly refreshToken?: string;

  constructor(
    private readonly opts: GlobalOptions,
    readonly companyId: string,
    private readonly hideReasoning: boolean,
    private readonly tui: Tui | null,
    tokens: { token: string; refreshToken?: string },
  ) {
    this.token = tokens.token;
    this.refreshToken = tokens.refreshToken;
  }

  private apiOpts(signal?: AbortSignal): ApiOptions {
    return apiOptions(this.opts, this.token, signal);
  }

  /** Whether any pane has a turn in flight. */
  get hasInFlightTurns(): boolean {
    return this.abortControllers.size > 0;
  }

  /** Whether `paneId` specifically has a turn in flight. */
  isBusy(paneId: string): boolean {
    return this.abortControllers.has(paneId);
  }

  /** Aborts every in-flight turn (the agents continue running server-side). */
  abortAllTurns(): void {
    for (const controller of this.abortControllers.values()) controller.abort();
    this.abortControllers.clear();
  }

  /**
   * Fetches the company's current role roster (used at startup and on
   * refresh), sorted alphabetically by name — roles have no `slug` field
   * yet, so name is the best available stable sort key for now.
   */
  async fetchRoles(): Promise<RoleOption[]> {
    const roles = await apiRequest<RoleOption[]>(
      this.apiOpts(),
      'GET',
      `/api/company/${this.companyId}/roles`,
    );
    return roles.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Reports a roster-pane-triggered failure (initiate-chat / refresh) into its pane log. */
  reportRosterError(err: unknown): void {
    this.tui?.appendEvent(this.companyId, {
      kind: 'agent_status',
      timestamp: new Date().toISOString(),
      data: {
        status: 'failed',
        reason: String(err instanceof Error ? err.message : err),
      },
    });
  }

  /**
   * Creates a new chat-mode agent for `roleId` and adds it as a pane (when
   * the TUI is active). Used both for the initial root agent (when
   * --role-id was given at startup) and for "initiate chat" selections made
   * from the company roster pane.
   */
  async startAgentPane(
    roleId: string,
    label: string,
    talkable: boolean,
  ): Promise<string> {
    const agent = await apiRequest<AgentRecord>(
      this.apiOpts(),
      'POST',
      '/api/agent/chat/start',
      { companyId: this.companyId, roleId },
    );
    this.agentIds.add(agent.id);
    this.tui?.addPane({ id: agent.id, label, talkable, roleId });
    return agent.id;
  }

  /** Deletes every agent created this session (best-effort). */
  async cleanup(): Promise<void> {
    for (const id of this.agentIds) {
      await this.deleteAgent(id);
    }
    this.agentIds.clear();
  }

  /**
   * Handles a tab being closed (Ctrl+W — the tab itself is already gone from
   * the TUI by the time this is called): aborts any turn in flight on that
   * pane, and deletes the underlying agent if this session created it.
   * Consultation-follower panes aren't session-owned agents, so closing one
   * of those just stops watching it — nothing to delete.
   */
  async closeTab(paneId: string): Promise<void> {
    const controller = this.abortControllers.get(paneId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(paneId);
    }
    if (this.agentIds.has(paneId)) {
      this.agentIds.delete(paneId);
      await this.deleteAgent(paneId);
    }
  }

  /** DELETEs one agent (best-effort — failures are logged, not thrown). */
  private async deleteAgent(id: string): Promise<void> {
    try {
      await apiRequest(this.apiOpts(), 'DELETE', `/api/agent/${id}`);
      process.stderr.write(`\nAgent ${id} removed.\n`);
    } catch {
      // best-effort cleanup
    }
  }

  /**
   * Runs one turn on `paneId`'s agent: opens the event stream, posts the
   * message, waits for the terminal event, then prints the final response.
   * `interactive` is only ever false for a `--query` turn with no TUI (piped
   * output, or `--no-tui`): progress streams to stderr and the final answer
   * prints to stdout once, keeping it pipeable. Every other case — normal
   * interactive turns, and `--query` turns once a TUI is involved — passes
   * `interactive: true`, so the response renders into the pane like any
   * other turn instead of being printed and torn down. Multiple panes can
   * each have a turn in flight concurrently — state is tracked per `paneId`.
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
      AbortSignal.timeout(35 * 60 * 1000),
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
      renderer.renderUserPrompt(message);
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
      if ('response' in outcome) {
        if (!interactive) {
          // Tear the TUI down before writing the final answer — it must
          // land in normal scrollback, not the (about to vanish) alt screen.
          this.tui?.stop();
          process.stdout.write(outcome.response + '\n');
        } else if (!renderer.responseSeen) {
          if (this.tui) {
            this.tui.appendEvent(paneId, {
              kind: 'response',
              timestamp: new Date().toISOString(),
              data: { delta: outcome.response },
            });
          } else {
            const text = outcome.response.trim() ? outcome.response : '(blank)';
            process.stdout.write(`\nResponse: ${text}\n`);
          }
        }
      } else if (outcome.error !== STREAM_ENDED) {
        if (this.tui) {
          this.tui.appendEvent(paneId, {
            kind: 'agent_status',
            timestamp: new Date().toISOString(),
            data: { status: 'failed', reason: outcome.error },
          });
        } else {
          process.stderr.write(`\n[Error] ${outcome.error}\n`);
        }
      }
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      if (this.tui) {
        this.tui.appendEvent(paneId, {
          kind: 'agent_status',
          timestamp: new Date().toISOString(),
          data: { status: 'failed', reason: message },
        });
      } else {
        process.stderr.write(`\nError: ${message}\n`);
      }
    } finally {
      this.abortControllers.delete(paneId);
      this.tui?.setBusy(paneId, false);
    }
  }

  /**
   * Opens the SSE stream for `id`, rendering each event until the agent's
   * terminal (`completed`/`failed`) event arrives. When the agent pauses to
   * consult another agent, spawns a follower stream for that agent, prefixed
   * with its role name. Resolves with the outcome; resolves with a
   * {@link STREAM_ENDED} error if the stream closes with no terminal event.
   */
  private async streamAgent(
    id: string,
    renderer: Renderer,
    signal: AbortSignal,
    onConnected?: () => void,
  ): Promise<TurnOutcome> {
    const url = `${this.opts.lcpServer.replace(/\/$/, '')}/api/agent/${id}/events`;
    const followerAbort = new AbortController();
    const followers: Promise<unknown>[] = [];
    let outcome: TurnOutcome | undefined;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.token}` },
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
        const { events, rest } = parseSseBuffer(buffer);
        buffer = rest;
        for (const event of events) {
          if (event.kind === 'completed') {
            outcome = { response: eventStr(event, 'response') };
            break;
          }
          if (event.kind === 'failed') {
            outcome = { error: eventStr(event, 'error') };
            break;
          }
          if (event.kind === 'consultation_started') {
            const consultId = eventStr(event, 'agentId');
            const consultRoleName = eventStr(event, 'roleName');
            renderer.render(event);
            if (consultId) {
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
                  rolePrefix: consultRoleName,
                  out: process.stderr,
                  err: process.stderr,
                });
              }
              followers.push(
                this.streamAgent(
                  consultId,
                  follower,
                  followerAbort.signal,
                ).catch(() => undefined),
              );
            }
            continue;
          }
          renderer.render(event);
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

  /** POSTs a message to `paneId`'s agent (expects 202), refreshing the token once on 401. */
  private async postMessage(
    paneId: string,
    message: string,
    signal: AbortSignal,
  ): Promise<void> {
    const doPost = () =>
      apiRequest<{ accepted: boolean }>(
        this.apiOpts(signal),
        'POST',
        `/api/agent/${paneId}/message`,
        { message },
      );
    try {
      await doPost();
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes('HTTP 401') &&
        this.refreshToken
      ) {
        this.token = await renewToken(this.opts.lcpServer, this.refreshToken);
        await doPost();
        return;
      }
      throw err;
    }
  }

  /**
   * Fallback when the SSE stream drops mid-turn: polls the agent record
   * until it reaches a terminal (or idle-after-run) state.
   */
  private async pollForCompletion(
    id: string,
    signal: AbortSignal,
  ): Promise<TurnOutcome> {
    const deadline = Date.now() + 35 * 60 * 1000;
    while (!signal.aborted && Date.now() < deadline) {
      await delay(2000, signal);
      if (signal.aborted) break;
      try {
        const agent = await apiRequest<{
          status: string;
          output?: string;
        }>(this.apiOpts(signal), 'GET', `/api/agent/${id}`);
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
