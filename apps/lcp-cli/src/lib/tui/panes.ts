// The pane class hierarchy for the TUI (see tui.ts, which orchestrates tabs,
// the tab bar/hint row, and the input box across whichever pane is active).
// Each concrete pane owns its own content and any post-render scroll
// behaviour: AssignmentPane (one agent's event log, following the tail — its
// backing assignment is what a task's plan actually schedules, hence the
// name, even though it's also used for a root/consultation agent's chat),
// RosterPane (the company's role list, scrolling to keep the highlight in
// view), and TextPane (fixed text — e.g. the help screen — with native
// scrolling).

import type { TaskChangeSummary } from '@lcp/shared';
import { TextBox } from 'terminal-kit';
import { SseEvent } from '../core/sse';
import {
  AssignmentRow,
  escapeMarkup,
  makeAssignmentEntry,
  makeRoleEntry,
  makeTaskEntry,
  marker,
  PaneEntryLog,
  renderAssignmentPaneHeading,
  renderMultiListPanel,
  renderRosterHeading,
  renderTaskPaneHeading,
  wrapText,
} from './tui-format';
import {
  AssignmentInfo,
  MultiListSelection,
  PaneAssignmentInfo,
  RoleOption,
  SelectableList,
} from './tui-state';

/** Task statuses shown in the roster's "Active" task group, most-recently-updated first. */
const ACTIVE_TASK_STATUSES = new Set([
  'ready',
  'planning',
  'in-progress',
  'finalising',
]);

/** Assignment statuses shown in a task pane's "Complete" group. */
const COMPLETE_ASSIGNMENT_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
]);

/**
 * Common behaviour for every pane: identity, its backing TextBox, and the
 * render/redraw cycle. Subclasses supply `render()`; `afterRedraw()` is the
 * hook for any scroll adjustment that must happen once new content is set
 * (follow-the-tail, scroll-to-selection, or nothing at all).
 */
export abstract class Pane {
  /** Whether this pane shows an input box when active. Only ChatPane overrides this. */
  readonly talkable: boolean = false;

  constructor(
    readonly id: string,
    public label: string,
    readonly textBox: TextBox,
  ) {}

  /** Re-renders this pane's content into its TextBox and applies any scroll adjustment. */
  redraw(): void {
    const width = Math.max(this.textBox.textAreaWidth, 1);
    this.textBox.setContent(this.render(width).join('\n'), true, true);
    this.afterRedraw();
  }

  /** Produces this pane's content lines at the given column width. */
  protected abstract render(width: number): string[];

  /** Scroll (or other) adjustment made right after content is set. Default: none. */
  protected afterRedraw(): void {
    // Most panes rely on native/manual scrolling; see ChatPane and RosterPane.
  }

  /** Scrolls this pane's TextBox so content line `line` (0-based) is within its viewport. */
  protected scrollLineIntoView(line: number): void {
    const height = this.textBox.textAreaHeight;
    if (line + this.textBox.scrollY < 0) {
      this.textBox.scrollTo(null, -line, true);
    } else if (line + this.textBox.scrollY > height - 1) {
      this.textBox.scrollTo(null, height - 1 - line, true);
    }
  }
}

/**
 * A monitored agent's tab: its event log (rendered under the agent/role/
 * assignment identifying heading — see {@link renderAssignmentPaneHeading}),
 * auto-scrolling to the newest entry unless the user has scrolled up to read
 * back through it. Named for its *backing assignment* (every agent works
 * exactly one — see `LcpAssignment`), not the chat UI, since that's what a
 * task's plan actually schedules and what the heading/tab now key off.
 */
export class AssignmentPane extends Pane {
  readonly talkable: boolean;
  /** The role's slug, for the heading's "Role name (and slug)" line.
   * Undefined for consultation-follower panes (the SSE event that creates
   * them carries a role name but no role id/slug). */
  private readonly roleSlug: string | undefined;
  /** This pane's backing assignment. Undefined for a consultation-follower
   * pane (not fetched — see `ChatSession.streamAgent`); heading fields that
   * need it render as `'—'` instead. */
  private readonly assignment: PaneAssignmentInfo | undefined;
  private readonly log: PaneEntryLog;
  /** Auto-scroll to the newest entry; cleared when the user scrolls up. */
  private follow = true;
  /** Whether this pane's agent has a turn in flight. */
  busy = false;
  /** Mid-typed input, preserved across switches away and back. */
  draft = '';

  constructor(
    id: string,
    label: string,
    textBox: TextBox,
    talkable: boolean,
    roleSlug: string | undefined,
    assignment: PaneAssignmentInfo | undefined,
    hideReasoning: boolean,
  ) {
    super(id, label, textBox);
    this.talkable = talkable;
    this.roleSlug = roleSlug;
    this.assignment = assignment;
    this.log = new PaneEntryLog(hideReasoning);
    // Wheel/scrollbar/native-key scrolls land here: keep following the tail
    // only while the user is actually at the bottom.
    textBox.on('scroll', () => {
      this.follow = this.atBottom();
    });
  }

  /** This pane's assignment shortcode, if known — used by Tui's tab label. */
  get assignmentShortcode(): string | null | undefined {
    return this.assignment?.shortcode;
  }

  /** Appends one SSE event to this pane's log. */
  appendEvent(event: SseEvent): void {
    this.log.append(event);
  }

  /** Appends the user's own submitted message as a distinctly-styled entry. */
  appendUserPrompt(text: string): void {
    this.log.pushUserPrompt(text);
  }

  /**
   * Scrolls by a page; +1 = towards older content. Only relevant when this
   * pane's own TextBox isn't focused — on a talkable pane the InlineInput
   * holds focus instead, so PgUp/PgDn never reach the TextBox's native
   * scroll bindings; Tui.handleKey calls this directly in that case.
   */
  page(direction: 1 | -1): void {
    const step = Math.max(this.textBox.textAreaHeight - 1, 1);
    this.textBox.scroll(0, direction * step, true);
    this.follow = this.atBottom();
  }

  protected render(width: number): string[] {
    const heading = renderAssignmentPaneHeading(
      this.id,
      this.label,
      this.roleSlug,
      this.assignment,
      width,
    );
    return [...heading, ...this.log.render(width)];
  }

  protected afterRedraw(): void {
    if (this.follow) this.textBox.scrollToBottom(true);
  }

  /** Whether the box is scrolled to its very bottom (scrollY is ≤ 0). */
  private atBottom(): boolean {
    return (
      this.textBox.scrollY <=
      this.textBox.textAreaHeight - this.textBox.getContentSize().height
    );
  }
}

/**
 * The company roster pane: a "Slug/Id" + prompt heading, then two
 * {@link SelectableList}s — Roles (the "initiate chat" list) and Tasks (the
 * company's tasks, grouped Active/Completed-or-failed, live-updating from
 * the company SSE stream) — with one flat `>` highlight moving across both.
 * Never talkable — Up/Down/Enter/r/[/] are handled by Tui.handleKey and
 * routed into this pane's own methods, since there's no InlineInput
 * competing for those keys.
 */
export class RosterPane extends Pane {
  readonly talkable = false;
  private readonly selection = new MultiListSelection();
  private lists: SelectableList[] = [];
  private selectedLine = -1;

  constructor(
    id: string,
    label: string,
    textBox: TextBox,
    public slug: string,
    public roles: RoleOption[],
    private tasks: TaskChangeSummary[] = [],
    private readonly taskListEntryMaxLines: number = 4,
  ) {
    super(id, label, textBox);
    this.rebuildLists();
  }

  /** The role at the current selection, or undefined when it's on the Tasks list (or nothing is selected). */
  get selectedRole(): RoleOption | undefined {
    const pos = this.selection.current;
    if (!pos || pos.listIndex !== 0) return undefined;
    return this.roles.find((role) => role.id === pos.entry.id);
  }

  /** The task at the current selection, or undefined when it's on the Roles list (or nothing is selected). */
  get selectedTask(): TaskChangeSummary | undefined {
    const pos = this.selection.current;
    if (!pos || pos.listIndex !== 1) return undefined;
    return this.tasks.find((task) => task.id === pos.entry.id);
  }

  /** Moves the flat highlight by `delta` rows, cycling top↔bottom across every list. */
  moveSelection(delta: number): void {
    this.selection.moveSelection(delta);
  }

  /** Jumps the highlight to the first selectable row of the previous (`-1`) or next (`1`) list. */
  jumpList(direction: 1 | -1): void {
    this.selection.jumpToList(direction);
  }

  /** Replaces the role list (e.g. the 'r' refresh key), clamping the selection. */
  setRoles(roles: RoleOption[]): void {
    this.roles = roles;
    this.rebuildLists();
  }

  /** Replaces the task list (live updates from the company SSE stream). */
  setTasks(tasks: TaskChangeSummary[]): void {
    this.tasks = tasks;
    this.rebuildLists();
  }

  private rebuildLists(): void {
    // String(...): a task's `updatedAt` is typed as a string, but that's not
    // runtime-enforced end to end — a mismatched value here must not crash
    // the whole TUI over a display-ordering comparator.
    const byRecency = (a: TaskChangeSummary, b: TaskChangeSummary): number =>
      String(b.updatedAt).localeCompare(String(a.updatedAt));
    const active = this.tasks
      .filter((t) => ACTIVE_TASK_STATUSES.has(t.status))
      .sort(byRecency);
    const done = this.tasks
      .filter((t) => !ACTIVE_TASK_STATUSES.has(t.status))
      .sort(byRecency);
    const taskEntry = (t: TaskChangeSummary) =>
      makeTaskEntry(t, this.taskListEntryMaxLines);

    this.lists = [
      {
        title: 'Roles',
        groups: [{ entries: this.roles.map(makeRoleEntry) }],
      },
      {
        title: 'Tasks',
        groups: [
          { title: 'Active', entries: active.map(taskEntry) },
          { title: 'Completed / failed', entries: done.map(taskEntry) },
        ],
      },
    ];
    this.selection.setLists(this.lists);
  }

  protected render(width: number): string[] {
    const heading = renderRosterHeading(this.slug, this.id);
    const { lines, selectedLine } = renderMultiListPanel(
      this.lists,
      this.selection.current,
      width,
    );
    this.selectedLine = selectedLine < 0 ? -1 : heading.length + selectedLine;
    return [...heading, ...lines];
  }

  protected afterRedraw(): void {
    if (this.selectedLine >= 0) this.scrollLineIntoView(this.selectedLine);
  }
}

/**
 * A task's pane: a `Task id:`/`Status:`/`Prompt:` heading, then a
 * single-list {@link SelectableList} ("Assignments", split Incomplete/
 * Complete — see {@link TaskPane.setAssignments}). Never talkable. Only
 * assignments that have begun are selectable (see `makeAssignmentEntry`);
 * selecting one opens the assignment pane.
 */
export class TaskPane extends Pane {
  readonly talkable = false;
  private readonly selection = new MultiListSelection();
  private lists: SelectableList[] = [];
  private selectedLine = -1;
  private assignments: AssignmentInfo[] = [];

  constructor(
    id: string,
    label: string,
    textBox: TextBox,
    private prompt: string,
    /** The task's current status, gating the cancel/start hints and shortcuts. */
    public status: string,
    assignments: AssignmentInfo[],
    private readonly assignmentListEntryMaxLines: number = 4,
  ) {
    super(id, label, textBox);
    this.setAssignments(assignments);
  }

  /**
   * Replaces the assignment list (initial fetch, or a task/assignment SSE
   * update), split into "Incomplete"/"Complete" groups — a terminal status
   * (`succeeded`/`failed`/`cancelled`) moves an assignment into Complete,
   * sorted (within each group) by its plan index, which it *keeps* even once
   * moved — the planning assignment stays index 0, an implement step keeps
   * its plan position, regardless of which group it's rendered in.
   */
  setAssignments(assignments: AssignmentInfo[]): void {
    this.assignments = assignments;
    const rows = assignments.map((a, i) => ({
      id: a.id,
      index: a.planIndex ?? i,
      role: a.role,
      status: a.status,
      prompt: a.prompt,
      agentId: a.agentId,
    }));
    const byIndex = (a: { index: number }, b: { index: number }) =>
      a.index - b.index;
    const complete = rows
      .filter((r) => COMPLETE_ASSIGNMENT_STATUSES.has(r.status))
      .sort(byIndex);
    const incomplete = rows
      .filter((r) => !COMPLETE_ASSIGNMENT_STATUSES.has(r.status))
      .sort(byIndex);
    const toEntry = (row: AssignmentRow) =>
      makeAssignmentEntry(row, this.assignmentListEntryMaxLines);
    this.lists = [
      {
        title: 'Assignments',
        groups: [
          { title: 'Incomplete', entries: incomplete.map(toEntry) },
          { title: 'Complete', entries: complete.map(toEntry) },
        ],
      },
    ];
    this.selection.setLists(this.lists);
  }

  /** Moves the highlight by `delta` rows, skipping not-yet-begun assignments. */
  moveSelection(delta: number): void {
    this.selection.moveSelection(delta);
  }

  /** The assignment at the current selection, or undefined if nothing is selected. */
  get selectedAssignment(): AssignmentInfo | undefined {
    const pos = this.selection.current;
    if (!pos) return undefined;
    return this.assignments.find((a) => a.id === pos.entry.id);
  }

  protected render(width: number): string[] {
    const heading = renderTaskPaneHeading(
      this.id,
      this.status,
      this.prompt,
      width,
    );
    const { lines, selectedLine } = renderMultiListPanel(
      this.lists,
      this.selection.current,
      width,
    );
    this.selectedLine = selectedLine < 0 ? -1 : heading.length + selectedLine;
    return [...heading, ...lines];
  }

  protected afterRedraw(): void {
    if (this.selectedLine >= 0) this.scrollLineIntoView(this.selectedLine);
  }
}

/** One row of the initiate-task form, in display order. */
type InitiateTaskRow =
  | { kind: 'prompt' }
  | { kind: 'role'; roleId: string; name: string }
  | { kind: 'expected'; filename: string }
  | { kind: 'add-expected' }
  | { kind: 'start-toggle' }
  | { kind: 'submit' };

/**
 * The initiate-task form: a fixed field list (prompt, planner role, add/
 * remove expected-output filenames, a start-immediately toggle, submit) — no
 * general form framework, just this panel's own rows. Never talkable;
 * text entry for the two free-text rows (prompt, a new expected filename) is
 * this panel's own minimal raw-key capture (see `Tui.handleKey`), not
 * terminal-kit's `InlineInput` (which only ever attaches to a *talkable*
 * pane, and — being single-purpose for "send a chat message" — has no notion
 * of "which of several fields is being typed into").
 *
 * ponytail: the text fields are append/backspace only, no interior cursor
 * movement — a real per-field cursor is the upgrade path if that's ever
 * needed; for a prompt and a filename, appending is enough.
 */
export class InitiateTaskPane extends Pane {
  readonly talkable = false;
  private selectedRow = 0;
  private prompt = '';
  private selectedRoleId: string | undefined;
  private expected: string[] = [];
  private startImmediately = false;
  private validationMessage: string | null = null;
  /** Which field is being raw-captured, if any; the draft text lives in `draft`. */
  editingField: 'prompt' | 'expected' | null = null;
  private draft = '';

  constructor(
    id: string,
    label: string,
    textBox: TextBox,
    readonly companyId: string,
    private roles: RoleOption[],
    defaultRoleId: string | undefined,
  ) {
    super(id, label, textBox);
    this.selectedRoleId = defaultRoleId;
  }

  private rows(): InitiateTaskRow[] {
    return [
      { kind: 'prompt' },
      ...this.roles.map(
        (r): InitiateTaskRow => ({ kind: 'role', roleId: r.id, name: r.name }),
      ),
      ...this.expected.map(
        (filename): InitiateTaskRow => ({ kind: 'expected', filename }),
      ),
      { kind: 'add-expected' },
      { kind: 'start-toggle' },
      { kind: 'submit' },
    ];
  }

  /** Row count without building the row array — prompt/add-expected/start-toggle/submit are always present. */
  private rowCount(): number {
    return 4 + this.roles.length + this.expected.length;
  }

  /** Moves the row highlight by `delta`, cycling top↔bottom. Ignored while editing a field. */
  moveSelection(delta: number): void {
    if (this.editingField) return;
    const count = this.rowCount();
    this.selectedRow = (this.selectedRow + delta + count) % count;
  }

  /** The row currently highlighted (for Enter/'d' to act on). */
  private currentRow(): InitiateTaskRow {
    return this.rows()[this.selectedRow];
  }

  /**
   * Enter on the highlighted row: starts editing the prompt or a new
   * expected filename, toggles a role/the start-immediately checkbox, or
   * validates and fires `onSubmit` (returning its result: `null` on
   * validation failure, the built request otherwise — {@link Tui} does the
   * actual API call and pane hand-off).
   */
  activateRow(): InitiateTaskSubmission | null | undefined {
    const row = this.currentRow();
    if (row.kind === 'prompt') {
      this.editingField = 'prompt';
      this.draft = this.prompt;
      return undefined;
    }
    if (row.kind === 'add-expected') {
      this.editingField = 'expected';
      this.draft = '';
      return undefined;
    }
    if (row.kind === 'role') {
      this.selectedRoleId = row.roleId;
      return undefined;
    }
    if (row.kind === 'start-toggle') {
      this.startImmediately = !this.startImmediately;
      return undefined;
    }
    // 'submit'
    if (!this.prompt.trim()) {
      this.validationMessage = 'Enter a prompt before submitting.';
      return null;
    }
    if (!this.selectedRoleId) {
      this.validationMessage = 'Select a planner role before submitting.';
      return null;
    }
    this.validationMessage = null;
    return {
      companyId: this.companyId,
      request: this.prompt.trim(),
      plannerRoleId: this.selectedRoleId,
      expected: [...this.expected],
      startImmediately: this.startImmediately,
    };
  }

  /** Removes the highlighted expected-output row ('d'), a no-op on any other row. */
  removeCurrentExpected(): void {
    const row = this.currentRow();
    if (row.kind !== 'expected') return;
    this.expected = this.expected.filter((f) => f !== row.filename);
    this.selectedRow = Math.min(this.selectedRow, this.rowCount() - 1);
  }

  /** Appends one character to the field being edited. No-op unless editing. */
  typeChar(ch: string): void {
    if (this.editingField) this.draft += ch;
  }

  /** Removes the last character of the field being edited. No-op unless editing. */
  backspace(): void {
    if (this.editingField) this.draft = this.draft.slice(0, -1);
  }

  /** Commits the field being edited (Enter while editing). No-op unless editing. */
  commitEdit(): void {
    if (this.editingField === 'prompt') {
      this.prompt = this.draft;
    } else if (this.editingField === 'expected') {
      const filename = this.draft.trim();
      if (filename) this.expected.push(filename);
    }
    this.editingField = null;
    this.draft = '';
  }

  protected render(width: number): string[] {
    const rows = this.rows();
    const lines: string[] = ['Initiate task', ''];
    rows.forEach((row, i) => {
      const mark = marker(i === this.selectedRow);
      lines.push(`${mark}${this.renderRow(row, i === this.selectedRow)}`);
    });
    if (this.validationMessage) {
      lines.push('', `^R${escapeMarkup(this.validationMessage)}^:`);
    }
    return lines.flatMap((line) => wrapText(line, width));
  }

  private renderRow(row: InitiateTaskRow, selected: boolean): string {
    switch (row.kind) {
      case 'prompt': {
        const text =
          selected && this.editingField === 'prompt'
            ? `${this.draft}_`
            : this.prompt || '(empty — Enter to type)';
        return `Prompt: "${escapeMarkup(text)}"`;
      }
      case 'role': {
        const chosen = row.roleId === this.selectedRoleId ? '(*)' : '( )';
        return `${chosen} ${escapeMarkup(row.name)}`;
      }
      case 'expected':
        return `- ${escapeMarkup(row.filename)} (d to remove)`;
      case 'add-expected': {
        const text =
          selected && this.editingField === 'expected' ? `${this.draft}_` : '';
        return text
          ? `+ Add expected output: "${escapeMarkup(text)}"`
          : '+ Add expected output';
      }
      case 'start-toggle':
        return `[${this.startImmediately ? 'x' : ' '}] Start immediately`;
      case 'submit':
        return 'Submit';
    }
  }
}

/** The task-create request built by {@link InitiateTaskPane.activateRow} on a valid submit. */
export interface InitiateTaskSubmission {
  companyId: string;
  request: string;
  plannerRoleId: string;
  expected: string[];
  startImmediately: boolean;
}

/**
 * A pane showing fixed, non-streaming text (e.g. the help screen) — no
 * input, no log, no heading; just the given lines, word-wrapped to the
 * pane's width, with native scrolling if they don't fit.
 */
export class TextPane extends Pane {
  readonly talkable = false;

  constructor(
    id: string,
    label: string,
    textBox: TextBox,
    private readonly lines: string[],
  ) {
    super(id, label, textBox);
  }

  protected render(width: number): string[] {
    return this.lines.flatMap((line) => wrapText(line, width));
  }
}
