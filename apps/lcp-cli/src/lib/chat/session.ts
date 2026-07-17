import type { LcpAssignment, LcpTask, TaskChangeSummary } from '@lcp/shared';
import type { UUID } from 'crypto';
import { GlobalOptions } from '../core/cli-options';
import {
  AuditRow,
  mapAuditHistoryToEvents,
} from '../core/audit-to-agent-events';
import { TokenManager, TokenSession } from '../auth/token';
import { createRenderer, Renderer } from '../core/render';
import { parseSseBuffer, SseEvent } from '../core/sse';
import { readSseStream } from '../core/sse-reader';
import {
  AssignmentInfo,
  InitiateTaskSubmission,
  RoleOption,
  Tui,
  tuiRenderer,
} from '../tui/tui';

interface AgentRecord {
  id: string;
  status: string;
}

/** Statuses beyond which an assignment's working agent has nothing left to stream live. */
const TERMINAL_AGENT_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/** Plain shape of `GET /api/task?companyId=` rows — just what the task list needs. */
interface TaskRecord {
  id: string;
  status: string;
  request: string;
  createdAt: string;
  updatedAt: string;
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

/**
 * Validates and narrows a `task_changed` SSE event's payload into a
 * {@link TaskChangeSummary}, rather than trusting/casting it directly —
 * `null` for a payload missing its required fields.
 */
function parseTaskChangeSummary(
  data: Record<string, unknown> | undefined,
): TaskChangeSummary | null {
  if (!data || typeof data.id !== 'string' || typeof data.status !== 'string') {
    return null;
  }
  return {
    id: data.id as UUID,
    status: data.status as TaskChangeSummary['status'],
    request: typeof data.request === 'string' ? data.request : '',
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : '',
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : '',
    completedSteps:
      typeof data.completedSteps === 'number' ? data.completedSteps : 0,
    totalSteps: typeof data.totalSteps === 'number' ? data.totalSteps : 0,
  };
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
 * Owns one chat session's mutable state — its {@link TokenManager}, every
 * agent created (for cleanup), and each pane's in-flight turn — and the
 * operations that act on it: starting agent panes, running a turn
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
  /** Owns the session's access token, refreshing it in the background so a
   * long-running TUI/chat session doesn't hit a stale-token 401. */
  private readonly tokenManager: TokenManager;
  /** The company's tasks, keyed by id — kept live by {@link watchCompanyEvents}. */
  private readonly tasksById = new Map<string, TaskChangeSummary>();
  private companyEventsAbort: AbortController | null = null;
  /** Open task panels' event-stream subscriptions, keyed by task id. */
  private readonly taskEventsAbort = new Map<string, AbortController>();
  /** Open assignment chat panels' live-follow subscriptions, keyed by agent id. */
  private readonly agentPaneWatchAbort = new Map<string, AbortController>();

  constructor(
    private readonly opts: GlobalOptions,
    readonly companyId: string,
    private readonly hideReasoning: boolean,
    private readonly tui: Tui | null,
    tokens: TokenSession,
  ) {
    this.tokenManager = new TokenManager(this.opts.lcpServer, tokens);
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
    const roles = await this.tokenManager.request<RoleOption[]>(
      'GET',
      `/api/company/${this.companyId}/roles`,
    );
    return roles.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Fetches the company's current tasks (used once at panel-open time, ahead
   * of {@link watchCompanyEvents}'s live updates). Step counts aren't in this
   * plain listing — placeholders here are corrected almost immediately by
   * the company SSE stream's priming `task_changed` events.
   */
  async fetchTasks(): Promise<TaskChangeSummary[]> {
    const tasks = await this.tokenManager.request<TaskRecord[]>(
      'GET',
      `/api/task?companyId=${this.companyId}`,
    );
    for (const task of tasks) {
      this.tasksById.set(task.id, {
        id: task.id as UUID,
        status: task.status as TaskChangeSummary['status'],
        request: task.request,
        // Same discipline as parseTaskChangeSummary below: don't trust the
        // wire shape blindly — a non-string date field must not reach
        // RosterPane's `.localeCompare` sort and crash the TUI.
        createdAt: typeof task.createdAt === 'string' ? task.createdAt : '',
        updatedAt: typeof task.updatedAt === 'string' ? task.updatedAt : '',
        completedSteps: 0,
        totalSteps: 0,
      });
    }
    return [...this.tasksById.values()];
  }

  /**
   * Opens `GET /api/company/:id/events` in the background and keeps the
   * roster pane's Tasks list live: `task_changed` upserts the one task named;
   * `company_changed` is just a signal today (no company-detail view to
   * refresh yet), so it's ignored. Aborted on {@link cleanup}.
   */
  watchCompanyEvents(): void {
    this.companyEventsAbort = new AbortController();
    const url = `${this.opts.lcpServer.replace(/\/$/, '')}/api/company/${this.companyId}/events`;
    void readSseStream(
      url,
      this.tokenManager.current,
      this.companyEventsAbort.signal,
      (event) => {
        if (event.kind !== 'task_changed') return;
        const summary = parseTaskChangeSummary(event.data);
        if (!summary) return;
        this.tasksById.set(summary.id, summary);
        this.tui?.updateRosterTasks(this.companyId, [
          ...this.tasksById.values(),
        ]);
      },
    );
  }

  /**
   * Reports a pane-triggered failure (initiate-chat/refresh on the roster,
   * cancel/start on a task panel) — into the pane's own log when it has one
   * (a {@link ChatPane}), and always to stderr too, since the roster and task
   * panels have no log of their own for `Tui.appendEvent` to reach.
   */
  reportPaneError(paneId: string, err: unknown): void {
    const message = String(err instanceof Error ? err.message : err);
    this.tui?.appendEvent(paneId, {
      kind: 'agent_status',
      timestamp: new Date().toISOString(),
      data: { status: 'failed', reason: message },
    });
    process.stderr.write(`\nError: ${message}\n`);
  }

  /**
   * Fetches a task with its assignments, resolving each assignment's role id
   * to its display name (an extra `GET /api/company/:id/roles` call) for the
   * task panel's Assignments list. The two fetches are independent — a
   * session's tasks always belong to its own `companyId` — so they run in
   * parallel rather than waiting for the task fetch to learn its companyId.
   */
  async fetchTaskDetail(
    taskId: string,
  ): Promise<{ task: LcpTask; assignments: AssignmentInfo[] }> {
    const [{ task, assignments }, roles] = await Promise.all([
      this.tokenManager.request<{
        task: LcpTask;
        assignments: LcpAssignment[];
      }>('GET', `/api/task/${taskId}`),
      this.tokenManager.request<{ id: string; name: string }[]>(
        'GET',
        `/api/company/${this.companyId}/roles`,
      ),
    ]);
    const roleNameById = new Map(roles.map((r) => [r.id, r.name]));
    return {
      task,
      assignments: assignments.map((a) => ({
        id: a.id,
        role: roleNameById.get(a.roleId) ?? a.roleId,
        status: a.status,
        prompt: a.prompt,
        agentId: a.agentId ?? null,
      })),
    };
  }

  /** Fetches the company's default planner role id (`LcpCompany.plannerRoleId`), if it has one. */
  async fetchCompanyDefaultPlannerRoleId(): Promise<string | undefined> {
    const company = await this.tokenManager.request<{
      plannerRoleId?: string | null;
    }>('GET', `/api/company/${this.companyId}`);
    return company.plannerRoleId ?? undefined;
  }

  /**
   * Creates a task from the initiate-task form's submission, starting it
   * immediately when requested, then returns its detail the same way
   * {@link fetchTaskDetail} does (for the task panel this hands off to).
   */
  async createTask(
    submission: InitiateTaskSubmission,
  ): Promise<{ task: LcpTask; assignments: AssignmentInfo[] }> {
    const expected = submission.expected.map((filename) => ({
      type: 'task-completed-path' as const,
      value: filename,
    }));
    const created = await this.tokenManager.request<LcpTask>(
      'POST',
      '/api/task',
      {
        companyId: submission.companyId,
        request: submission.request,
        plannerRoleId: submission.plannerRoleId,
        ...(expected.length > 0 ? { expected } : {}),
      },
    );
    if (submission.startImmediately) {
      await this.tokenManager.request('POST', `/api/task/${created.id}/start`);
    }
    return this.fetchTaskDetail(created.id);
  }

  /**
   * Opens `GET /api/task/:id/events` for an open task panel and keeps it
   * live: `task_changed` updates the pane's own status (drives the
   * cancel/start hint and shortcut gating); `assignment_changed` re-fetches
   * the task's full detail and refreshes the pane's Assignments list.
   *
   * ponytail: refetches on every assignment_changed rather than patching the
   * one changed row in place (the event payload has no prompt/role, so a
   * genuinely new assignment — e.g. QA, finalise — needs the full re-fetch
   * anyway); promote to patch-in-place if this task's assignment churn ever
   * makes the extra round-trips a real cost.
   */
  watchTaskEvents(taskId: string): void {
    const abort = new AbortController();
    this.taskEventsAbort.set(taskId, abort);
    const url = `${this.opts.lcpServer.replace(/\/$/, '')}/api/task/${taskId}/events`;
    void readSseStream(
      url,
      this.tokenManager.current,
      abort.signal,
      (event) => {
        if (event.kind === 'task_changed') {
          const status = eventStr(event, 'status');
          if (status) this.tui?.updateTaskPaneStatus(taskId, status);
          return;
        }
        if (event.kind !== 'assignment_changed') return;
        void this.fetchTaskDetail(taskId)
          .then(({ assignments }) => {
            this.tui?.updateTaskPaneAssignments(taskId, assignments);
          })
          .catch(() => {
            // best-effort live refresh — the panel keeps its last-known state
          });
      },
    );
  }

  /** Stops watching a task panel's events (e.g. Ctrl+W closed it). */
  stopWatchingTask(taskId: string): void {
    this.taskEventsAbort.get(taskId)?.abort();
    this.taskEventsAbort.delete(taskId);
  }

  /** Cancels a task from its task panel (`POST /api/task/:id/cancel`). */
  async cancelTask(taskId: string): Promise<void> {
    try {
      await this.tokenManager.request('POST', `/api/task/${taskId}/cancel`);
    } catch (err) {
      this.reportPaneError(taskId, err);
    }
  }

  /** Starts a `ready` task from its task panel (`POST /api/task/:id/start`). */
  async startTask(taskId: string): Promise<void> {
    try {
      await this.tokenManager.request('POST', `/api/task/${taskId}/start`);
    } catch (err) {
      this.reportPaneError(taskId, err);
    }
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
    const agent = await this.tokenManager.request<AgentRecord>(
      'POST',
      '/api/agent/chat/start',
      { companyId: this.companyId, roleId },
    );
    this.agentIds.add(agent.id);
    this.tui?.addPane({ id: agent.id, label, talkable, roleId });
    return agent.id;
  }

  /**
   * Opens (or switches to, if already open) a read-only chat panel for a
   * begun assignment's working agent: follows its live SSE stream while
   * still running, or renders its full audit history (mapped into the same
   * event shapes the live stream produces) once it has finished.
   */
  async openAssignmentChatPane(assignment: AssignmentInfo): Promise<void> {
    const agentId = assignment.agentId;
    if (!agentId) return; // shouldn't happen — the panel only offers begun assignments
    if (this.tui?.hasPane(agentId)) {
      this.tui.switchToPane(agentId);
      return;
    }
    const agent = await this.tokenManager.request<AgentRecord>(
      'GET',
      `/api/agent/${agentId}`,
    );
    this.tui?.addPane({ id: agentId, label: assignment.role, talkable: false });
    if (TERMINAL_AGENT_STATUSES.has(agent.status)) {
      const rows = await this.tokenManager.request<AuditRow[]>(
        'GET',
        `/api/agent/${agentId}/history`,
      );
      for (const event of mapAuditHistoryToEvents(rows)) {
        this.tui?.appendEvent(agentId, event);
      }
    } else {
      const abort = new AbortController();
      this.agentPaneWatchAbort.set(agentId, abort);
      const url = `${this.opts.lcpServer.replace(/\/$/, '')}/api/agent/${agentId}/events`;
      void readSseStream(
        url,
        this.tokenManager.current,
        abort.signal,
        (event) => {
          this.tui?.appendEvent(agentId, event);
        },
      );
    }
    this.tui?.switchToPane(agentId);
  }

  /** Deletes every agent created this session (best-effort), and stops watching company/task/assignment events. */
  async cleanup(): Promise<void> {
    this.companyEventsAbort?.abort();
    this.companyEventsAbort = null;
    for (const abort of this.taskEventsAbort.values()) abort.abort();
    this.taskEventsAbort.clear();
    for (const abort of this.agentPaneWatchAbort.values()) abort.abort();
    this.agentPaneWatchAbort.clear();
    for (const id of this.agentIds) {
      await this.deleteAgent(id);
    }
    this.agentIds.clear();
    this.tokenManager.stop();
  }

  /**
   * Handles a tab being closed (Ctrl+W — the tab itself is already gone from
   * the TUI by the time this is called): aborts any turn in flight on that
   * pane, deletes the underlying agent if this session created it, and stops
   * watching its task/assignment-chat events if it was one of those panels.
   * Consultation-follower panes aren't session-owned agents, so closing one
   * of those just stops watching it — nothing to delete.
   */
  async closeTab(paneId: string): Promise<void> {
    this.stopWatchingTask(paneId);
    this.agentPaneWatchAbort.get(paneId)?.abort();
    this.agentPaneWatchAbort.delete(paneId);
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
      await this.tokenManager.request('DELETE', `/api/agent/${id}`);
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
        headers: { Authorization: `Bearer ${this.tokenManager.current}` },
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

  /** POSTs a message to `paneId`'s agent (expects 202); {@link TokenManager.request} handles a 401 by refreshing and retrying. */
  private async postMessage(
    paneId: string,
    message: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.tokenManager.request<{ accepted: boolean }>(
      'POST',
      `/api/agent/${paneId}/message`,
      { message },
      signal,
    );
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
        const agent = await this.tokenManager.request<{
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
