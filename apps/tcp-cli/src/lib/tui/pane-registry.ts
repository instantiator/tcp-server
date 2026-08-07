// Which panes exist, in what tab order, and the TextBox each one draws into.
// The Tui delegates every add/remove/replace here and then redraws; nothing in
// this module draws anything itself.

import { Document, TextBox } from 'terminal-kit';
import { AssignmentPane } from './panes/assignment-pane';
import { InitiateTaskPane } from './panes/initiate-task-pane';
import { Pane } from './panes/pane';
import { RosterPane } from './panes/roster-pane';
import { TaskPane } from './panes/task-pane';
import { TextPane } from './panes/text-pane';
import { HELP_PANE_ID, HELP_TEXT } from './tui-help';
import { CONTENT_TOP } from './tui-layout';
import { AssignmentInfo, PaneManager, PaneSpec, RoleOption } from './tui-state';

/** Fixed id for the (at most one) initiate-task form pane. */
export const INITIATE_TASK_PANE_ID = '__initiate_task__';

/** Everything needed to open a task's own pane. */
export interface TaskPaneSpec {
  id: string;
  label: string;
  prompt: string;
  status: string;
  assignments: AssignmentInfo[];
}

/**
 * The TUI's set of panes: their tab order and active selection (via
 * {@link PaneManager}), the {@link Pane} instances themselves, and the
 * scrollback TextBox each is constructed with.
 *
 * NB. every pane's TextBox is created hidden and 1 row high; `Tui.layout`
 * sizes and positions it for the current terminal, and `Tui.refresh` shows
 * whichever is active.
 */
export class PaneRegistry {
  private readonly manager = new PaneManager();
  private readonly panes = new Map<string, Pane>();

  constructor(
    private readonly document: Document,
    private readonly width: () => number,
    private readonly hideReasoning: boolean,
    private readonly taskListEntryMaxLines: number,
  ) {}

  /** The active pane's spec, or null when there are no panes at all. */
  get activeSpec(): PaneSpec | null {
    return this.manager.activePane;
  }

  /** The active pane, or undefined when there are no panes at all. */
  get active(): Pane | undefined {
    const active = this.manager.activePane;
    return active ? this.panes.get(active.id) : undefined;
  }

  /** Whether the active pane accepts typed input (i.e. wants an input box). */
  get inputEnabled(): boolean {
    return this.manager.inputEnabled;
  }

  /** Every pane's spec, in tab order. */
  get specsInOrder(): PaneSpec[] {
    return this.manager.panesInOrder;
  }

  /** Every pane, for whole-set operations such as layout and show/hide. */
  get all(): Pane[] {
    return [...this.panes.values()];
  }

  /** Whether a pane with this id is already open. */
  has(id: string): boolean {
    return this.panes.has(id);
  }

  /** The pane with this id, if it is open. */
  get(id: string): Pane | undefined {
    return this.panes.get(id);
  }

  /** Makes `id` the active tab. No-op for an unknown id. */
  switchTo(id: string): void {
    this.manager.switchTo(id);
  }

  /** Activates the next tab, cycling round. */
  next(): void {
    this.manager.next();
  }

  /** Activates the previous tab, cycling round. */
  prev(): void {
    this.manager.prev();
  }

  /** Adds a tab for an agent (talkable = the user can address it directly). */
  addAssignment(spec: PaneSpec): void {
    if (this.panes.has(spec.id)) return;
    this.manager.addPane(spec);
    this.panes.set(
      spec.id,
      new AssignmentPane(
        spec.id,
        spec.label,
        this.createContentTextBox(),
        spec.talkable,
        spec.roleSlug,
        spec.assignment,
        this.hideReasoning,
      ),
    );
  }

  /**
   * Adds the company roster pane: a spectate-only (no input box) tab listing
   * the company's roles and tasks. Only one is expected per session.
   */
  addRoster(spec: {
    id: string;
    label: string;
    slug: string;
    roles: RoleOption[];
  }): void {
    if (this.panes.has(spec.id)) return;
    this.manager.addPane({ id: spec.id, label: spec.label, talkable: false });
    this.panes.set(
      spec.id,
      new RosterPane(
        spec.id,
        spec.label,
        this.createContentTextBox(),
        spec.slug,
        spec.roles,
        [],
        this.taskListEntryMaxLines,
      ),
    );
  }

  /** Adds a task's pane, or does nothing if it is already open. */
  addTask(spec: TaskPaneSpec): void {
    if (this.panes.has(spec.id)) return;
    this.manager.addPane({ id: spec.id, label: spec.label, talkable: false });
    this.panes.set(spec.id, this.buildTask(spec));
  }

  /**
   * Replaces an open pane (the initiate-task form) with the newly created
   * task's task panel, in the same tab slot rather than appending a new tab.
   */
  replaceWithTask(oldPaneId: string, spec: TaskPaneSpec): void {
    const oldPane = this.panes.get(oldPaneId);
    if (!oldPane) return;
    oldPane.textBox.destroy(false, true);
    this.panes.delete(oldPaneId);
    this.manager.replacePane(oldPaneId, {
      id: spec.id,
      label: spec.label,
      talkable: false,
    });
    this.panes.set(spec.id, this.buildTask(spec));
  }

  /**
   * Creates the initiate-task form pane if it isn't already open. At most one
   * is ever open, at the fixed {@link INITIATE_TASK_PANE_ID}.
   */
  ensureInitiateTask(spec: {
    companyId: string;
    roles: RoleOption[];
    defaultRoleId?: string;
  }): void {
    if (this.panes.has(INITIATE_TASK_PANE_ID)) return;
    const label = 'New task';
    this.manager.addPane({
      id: INITIATE_TASK_PANE_ID,
      label,
      talkable: false,
    });
    this.panes.set(
      INITIATE_TASK_PANE_ID,
      new InitiateTaskPane(
        INITIATE_TASK_PANE_ID,
        label,
        this.createContentTextBox(),
        spec.companyId,
        spec.roles,
        spec.defaultRoleId,
      ),
    );
  }

  /**
   * Creates the help pane if it isn't already open.
   *
   * NB. it self-closes when the user tabs (or Esc's) away — see
   * `Tui.closeIfSelfClosing` — so re-opening always starts fresh.
   */
  ensureHelp(): void {
    if (this.panes.has(HELP_PANE_ID)) return;
    const label = 'Help';
    this.manager.addPane({ id: HELP_PANE_ID, label, talkable: false });
    this.panes.set(
      HELP_PANE_ID,
      new TextPane(HELP_PANE_ID, label, this.createContentTextBox(), HELP_TEXT),
    );
  }

  /** Removes a pane and destroys its TextBox. No-op for an unknown id. */
  remove(id: string): void {
    const pane = this.panes.get(id);
    if (pane) {
      pane.textBox.destroy(false, true);
      this.panes.delete(id);
    }
    this.manager.removePane(id);
  }

  private buildTask(spec: TaskPaneSpec): TaskPane {
    return new TaskPane(
      spec.id,
      spec.label,
      this.createContentTextBox(),
      spec.prompt,
      spec.status,
      spec.assignments,
      this.taskListEntryMaxLines,
    );
  }

  /** A scrollable, initially-hidden content TextBox at the pane content area. */
  private createContentTextBox(): TextBox {
    return new TextBox({
      parent: this.document,
      x: 0,
      y: CONTENT_TOP,
      width: this.width(),
      height: 1,
      scrollable: true,
      vScrollBar: true,
      hidden: true,
    });
  }
}
