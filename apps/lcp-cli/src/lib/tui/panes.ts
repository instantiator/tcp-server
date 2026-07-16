// The pane class hierarchy for the TUI (see tui.ts, which orchestrates tabs,
// the tab bar/hint row, and the input box across whichever pane is active).
// Each concrete pane owns its own content and any post-render scroll
// behaviour: ChatPane (an agent's event log, following the tail), RosterPane
// (the company's role list, scrolling to keep the highlight in view), and
// TextPane (fixed text — e.g. the help screen — with native scrolling).

import type { TaskChangeSummary } from '@lcp/shared';
import { TextBox } from 'terminal-kit';
import { SseEvent } from '../core/sse';
import {
  makeRoleEntry,
  makeTaskEntry,
  PaneEntryLog,
  renderMultiListPanel,
  renderPaneHeading,
  renderRosterHeading,
  wrapText,
} from './tui-format';
import { MultiListSelection, RoleOption, SelectableList } from './tui-state';

/** Task statuses shown in the roster's "Active" task group, most-recently-updated first. */
const ACTIVE_TASK_STATUSES = new Set([
  'ready',
  'planning',
  'in-progress',
  'finalising',
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
 * A monitored agent's tab: its event log (rendered under a "Name/Id"
 * heading), auto-scrolling to the newest entry unless the user has
 * scrolled up to read back through it.
 */
export class ChatPane extends Pane {
  readonly talkable: boolean;
  /** The role's own id, for the heading — distinct from `id` (the agent id)
   * since a role can have many agents over time. Undefined for
   * consultation-follower panes (the SSE event that creates them carries a
   * role name but no role id); the heading then falls back to `id`. */
  private readonly roleId: string | undefined;
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
    roleId: string | undefined,
    hideReasoning: boolean,
  ) {
    super(id, label, textBox);
    this.talkable = talkable;
    this.roleId = roleId;
    this.log = new PaneEntryLog(hideReasoning);
    // Wheel/scrollbar/native-key scrolls land here: keep following the tail
    // only while the user is actually at the bottom.
    textBox.on('scroll', () => {
      this.follow = this.atBottom();
    });
  }

  /** Appends one SSE event to this pane's log. */
  appendEvent(event: SseEvent): void {
    this.log.append(event);
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
    const heading = renderPaneHeading(this.label, this.roleId ?? this.id);
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
    const active = this.tasks
      .filter((t) => ACTIVE_TASK_STATUSES.has(t.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const done = this.tasks
      .filter((t) => !ACTIVE_TASK_STATUSES.has(t.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
