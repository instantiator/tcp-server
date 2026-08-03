import type { TaskChangeSummary, TcpTask } from '@tcp/shared';
import { GlobalOptions } from '../core/cli-options';
import { TokenManager, TokenSession } from '../auth/token';
import { readWireStream } from '../core/sse-reader';
import { auditWire, failedWire, toWire } from '../render/audit-wire';
import {
  AssignmentInfo,
  InitiateTaskSubmission,
  RoleOption,
  Tui,
} from '../tui/tui';
import * as api from './session-api';
import { TurnRunner } from './turn-runner';
import { parseTaskChangeSummary, str } from './wire-parse';

/** Statuses beyond which an assignment's working agent has nothing left to stream live. */
const TERMINAL_AGENT_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * Owns one chat session's mutable state — its {@link TokenManager}, every agent
 * created (for cleanup), and its open event subscriptions — and the operations
 * that act on it: starting agent panes, keeping the roster and task panels
 * live, and cleanup.
 *
 * Turns themselves are run by {@link TurnRunner}; the REST calls live in
 * {@link api}.
 *
 * NB. kept as a class (rather than closures, as before this file was split out)
 * because nearly every operation shares this same mutable state; the class just
 * gives that state a name instead of a chain of captured variables.
 */
export class ChatSession {
  private readonly agentIds = new Set<string>();
  /** Owns the session's access token, refreshing it in the background so a
   * long-running TUI/chat session doesn't hit a stale-token 401. */
  private readonly tokenManager: TokenManager;
  private readonly turns: TurnRunner;
  /** The company's tasks, keyed by id — kept live by {@link watchCompanyEvents}. */
  private readonly tasksById = new Map<string, TaskChangeSummary>();
  private companyEventsAbort: AbortController | null = null;
  /** Open task panels' event-stream subscriptions, keyed by task id. */
  private readonly taskEventsAbort = new Map<string, AbortController>();
  /** Open assignment chat panels' live-follow subscriptions, keyed by agent id. */
  private readonly assignmentPaneWatchAbort = new Map<
    string,
    AbortController
  >();

  constructor(
    private readonly opts: GlobalOptions,
    readonly companyId: string,
    hideReasoning: boolean,
    private readonly tui: Tui | null,
    tokens: TokenSession,
  ) {
    this.tokenManager = new TokenManager(this.opts.tcpServer, tokens);
    this.turns = new TurnRunner(
      this.tokenManager,
      this.opts.tcpServer,
      this.tui,
      hideReasoning,
    );
  }

  /** Whether any pane has a turn in flight. */
  get hasInFlightTurns(): boolean {
    return this.turns.hasInFlightTurns;
  }

  /** Whether `paneId` specifically has a turn in flight. */
  isBusy(paneId: string): boolean {
    return this.turns.isBusy(paneId);
  }

  /** Aborts every in-flight turn (the agents continue running server-side). */
  abortAllTurns(): void {
    this.turns.abortAll();
  }

  /** Runs one turn on `paneId`'s agent — see {@link TurnRunner.runTurn}. */
  async runTurn(
    paneId: string,
    message: string,
    interactive: boolean,
  ): Promise<void> {
    await this.turns.runTurn(paneId, message, interactive);
  }

  /** Fetches the company's role roster (used at startup and on refresh). */
  async fetchRoles(): Promise<RoleOption[]> {
    return api.fetchRoles(this.tokenManager, this.companyId);
  }

  /**
   * Fetches the company's current tasks, once at panel-open time, ahead of
   * {@link watchCompanyEvents}'s live updates.
   */
  async fetchTasks(): Promise<TaskChangeSummary[]> {
    const tasks = await api.fetchTasks(this.tokenManager, this.companyId);
    for (const task of tasks) this.tasksById.set(task.id, task);
    return [...this.tasksById.values()];
  }

  /**
   * Opens `GET /api/company/:id/events` in the background and keeps the roster
   * pane's Tasks list live.
   *
   * `task_changed` upserts the one task named; `company_changed` is just a
   * signal today (no company-detail view to refresh yet), so it's ignored.
   * Aborted on {@link cleanup}.
   */
  watchCompanyEvents(): void {
    this.companyEventsAbort = new AbortController();
    const url = `${this.baseUrl}/api/company/${this.companyId}/events`;
    void readWireStream(
      url,
      this.tokenManager.current,
      this.companyEventsAbort.signal,
      (wire) => {
        if (wire.type !== 'audit' || wire.event.payload['entity'] !== 'task') {
          return;
        }
        const summary = parseTaskChangeSummary(
          wire.event.payload['summary'] as Record<string, unknown> | undefined,
        );
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
   * (an `AssignmentPane`), and always to stderr too, since the roster and task
   * panels have no log of their own for `Tui.appendEvent` to reach.
   */
  reportPaneError(paneId: string, err: unknown): void {
    const message = String(err instanceof Error ? err.message : err);
    this.tui?.appendEvent(paneId, failedWire(message));
    this.tui?.showPaneError(paneId, message);
    process.stderr.write(`\nError: ${message}\n`);
  }

  /** Fetches a task with its assignments, for the task panel's list. */
  async fetchTaskDetail(
    taskId: string,
  ): Promise<{ task: TcpTask; assignments: AssignmentInfo[] }> {
    return api.fetchTaskDetail(this.tokenManager, this.companyId, taskId);
  }

  /** Fetches the company's default planner role id, if it has one. */
  async fetchCompanyDefaultPlannerRoleId(): Promise<string | undefined> {
    return api.fetchCompanyDefaultPlannerRoleId(
      this.tokenManager,
      this.companyId,
    );
  }

  /** Creates a task from the initiate-task form's submission. */
  async createTask(
    submission: InitiateTaskSubmission,
  ): Promise<{ task: TcpTask; assignments: AssignmentInfo[] }> {
    return api.createTask(this.tokenManager, submission);
  }

  /**
   * Opens `GET /api/task/:id/events` for an open task panel and keeps it live:
   * `task_changed` updates the pane's own status (drives the cancel/start hint
   * and shortcut gating); `assignment_changed` re-fetches the task's full
   * detail and refreshes the pane's Assignments list.
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
    const url = `${this.baseUrl}/api/task/${taskId}/events`;
    void readWireStream(
      url,
      this.tokenManager.current,
      abort.signal,
      (wire) => {
        if (wire.type !== 'audit') return;
        const entity = wire.event.payload['entity'];
        if (entity === 'task') {
          const status = str(wire.event.payload, 'newStatus');
          if (status) this.tui?.updateTaskPaneStatus(taskId, status);
          return;
        }
        if (entity !== 'assignment') return;
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

  /** Cancels a task from its task panel, reporting failure onto its pane. */
  async cancelTask(taskId: string): Promise<void> {
    try {
      await api.cancelTask(this.tokenManager, taskId);
    } catch (err) {
      this.reportPaneError(taskId, err);
    }
  }

  /** Starts a `ready` task from its task panel, reporting failure onto its pane. */
  async startTask(taskId: string): Promise<void> {
    try {
      await api.startTask(this.tokenManager, taskId);
    } catch (err) {
      this.reportPaneError(taskId, err);
    }
  }

  /**
   * Creates a new chat-mode agent for `roleId` and adds it as a pane (when the
   * TUI is active).
   *
   * Used both for the initial root agent (when --role-id was given at startup)
   * and for "initiate chat" selections made from the company roster pane.
   *
   * NB. its backing assignment is an orphan (a plain conversation, not part of
   * any task's plan) — fetched anyway so the pane's heading can show its
   * id/status/prompt. The shortcode is always null here, so the tab label falls
   * back to `label`.
   */
  async startAssignmentPane(
    roleId: string,
    roleSlug: string,
    label: string,
    talkable: boolean,
  ): Promise<string> {
    const agent = await api.startChatAgent(
      this.tokenManager,
      this.companyId,
      roleId,
    );
    this.agentIds.add(agent.id);
    const assignment = await api.fetchAssignment(
      this.tokenManager,
      agent.assignmentId,
    );
    this.tui?.addPane({
      id: agent.id,
      label,
      talkable,
      roleSlug,
      assignment,
    });
    return agent.id;
  }

  /**
   * Opens (or switches to, if already open) a read-only chat panel for a begun
   * assignment's working agent.
   *
   * First renders its audit history up to now (mapped into the same event
   * shapes the live stream produces), then — if the agent is still running —
   * follows its live SSE stream for whatever happens next. A finished agent
   * shows history only; nothing is live.
   */
  async openAssignmentChatPane(assignment: AssignmentInfo): Promise<void> {
    const agentId = assignment.agentId;
    if (!agentId) return; // shouldn't happen — the panel only offers begun assignments
    if (this.tui?.hasPane(agentId)) {
      this.tui.switchToPane(agentId);
      return;
    }
    const agent = await api.fetchAgent(this.tokenManager, agentId);
    this.tui?.addPane({
      id: agentId,
      label: assignment.role,
      talkable: false,
      roleSlug: assignment.roleSlug,
      assignment: {
        id: assignment.id,
        shortcode: assignment.shortcode,
        status: assignment.status,
        prompt: assignment.prompt,
        failureReason: assignment.failureReason,
      },
    });

    // History up to now — for a running agent this is everything before the
    // pane was opened, which the live stream (new events only) would otherwise
    // miss.
    const rows = await api.fetchAgentHistory(this.tokenManager, agentId);
    for (const row of rows) {
      this.tui?.appendEvent(agentId, auditWire(toWire(row)));
    }

    // ...then follow live if it's still going. ponytail: an event landing in
    // the gap between the history fetch and this subscription can be missed;
    // acceptable for a read-only observability pane. Tighten (subscribe-then-
    // fetch-then-dedup) only if that boundary turn ever matters.
    if (!TERMINAL_AGENT_STATUSES.has(agent.status)) {
      const abort = new AbortController();
      this.assignmentPaneWatchAbort.set(agentId, abort);
      const url = `${this.baseUrl}/api/agent/${agentId}/events`;
      void readWireStream(
        url,
        this.tokenManager.current,
        abort.signal,
        (wire) => {
          this.tui?.appendEvent(agentId, wire);
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
    for (const abort of this.assignmentPaneWatchAbort.values()) abort.abort();
    this.assignmentPaneWatchAbort.clear();
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
   *
   * NB. consultation-follower panes aren't session-owned agents, so closing one
   * of those just stops watching it — nothing to delete.
   */
  async closeTab(paneId: string): Promise<void> {
    this.stopWatchingTask(paneId);
    this.assignmentPaneWatchAbort.get(paneId)?.abort();
    this.assignmentPaneWatchAbort.delete(paneId);
    this.turns.abort(paneId);
    if (this.agentIds.has(paneId)) {
      this.agentIds.delete(paneId);
      await this.deleteAgent(paneId);
    }
  }

  /** The tcp-server's base URL, without a trailing slash. */
  private get baseUrl(): string {
    return this.opts.tcpServer.replace(/\/$/, '');
  }

  /** DELETEs one agent (best-effort — failures are logged, not thrown). */
  private async deleteAgent(id: string): Promise<void> {
    try {
      await api.deleteAgent(this.tokenManager, id);
      process.stderr.write(`\nAgent ${id} removed.\n`);
    } catch {
      // best-effort cleanup
    }
  }
}
