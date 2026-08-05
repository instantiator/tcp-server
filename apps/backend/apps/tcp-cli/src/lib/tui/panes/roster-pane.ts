import type { TaskChangeSummary } from '@tcp/shared';
import { TextBox } from 'terminal-kit';
import {
  makeRoleEntry,
  makeTaskEntry,
  renderRosterHeading,
} from '../tui-format';
import { RoleOption } from '../tui-state';
import { MultiListPane } from './pane';

/** Task statuses shown in the roster's "Active" task group, most-recently-updated first. */
const ACTIVE_TASK_STATUSES = new Set([
  'ready',
  'planning',
  'in-progress',
  'finalising',
]);

/**
 * The company roster pane: a "Slug/Id" + prompt heading, then two
 * {@link SelectableList}s — Roles (the "initiate chat" list) and Tasks (the
 * company's tasks, grouped Active/Completed-or-failed, live-updating from
 * the company SSE stream) — with one flat `>` highlight moving across both.
 * Never talkable — Up/Down/Enter/r/[/] are handled by Tui.handleKey and
 * routed into this pane's own methods, since there's no InlineInput
 * competing for those keys.
 */
export class RosterPane extends MultiListPane {
  readonly talkable = false;

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
    this.errorMessage = null;
    this.rebuildLists();
  }

  /** Replaces the task list (e.g. the 'r' refresh key, or a live update from the company SSE stream). */
  setTasks(tasks: TaskChangeSummary[]): void {
    this.tasks = tasks;
    this.errorMessage = null;
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

  protected renderHeading(): string[] {
    return renderRosterHeading(this.slug, this.id);
  }
}
