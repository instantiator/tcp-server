import { TextBox } from 'terminal-kit';
import {
  AssignmentRow,
  makeAssignmentEntry,
  renderTaskPaneHeading,
} from '../tui-format';
import { AssignmentInfo } from '../tui-state';
import { MultiListPane } from './pane';

/** Assignment statuses shown in a task pane's "Complete" group. */
const COMPLETE_ASSIGNMENT_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
]);

/** Task statuses a task can still be cancelled from. */
const CANCELLABLE_TASK_STATUSES = new Set([
  'planning',
  'in-progress',
  'finalising',
]);

/**
 * A task's pane: a `Task id:`/`Status:`/`Prompt:` heading, then a
 * single-list {@link SelectableList} ("Assignments", split Incomplete/
 * Complete — see {@link TaskPane.setAssignments}). Never talkable. Only
 * assignments that have begun are selectable (see `makeAssignmentEntry`);
 * selecting one opens the assignment pane.
 */
export class TaskPane extends MultiListPane {
  readonly talkable = false;
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
    this.errorMessage = null;
    this.rebuildLists();
  }

  /**
   * Patches one assignment's live agent status in place, from an agent
   * `state_change` on the company stream (`ChatSession.watchCompanyEvents`,
   * routed here via `Tui.updateTaskPaneAgentStatus`) — no refetch, and
   * (unlike {@link setAssignments}) the pane's error banner is left alone,
   * since this isn't a response to any pane-triggered action. Returns
   * whether this pane held that agent, so the caller can skip a redraw when
   * it doesn't.
   */
  updateAgentStatus(agentId: string, status: string): boolean {
    const index = this.assignments.findIndex((a) => a.agentId === agentId);
    if (index === -1) return false;
    this.assignments = this.assignments.map((a, i) =>
      i === index ? { ...a, agentStatus: status } : a,
    );
    this.rebuildLists();
    return true;
  }

  /** Re-derives {@link lists} (and the selection) from {@link assignments} — the Incomplete/Complete split described on {@link setAssignments}. */
  private rebuildLists(): void {
    const rows = this.assignments.map((a, i) => ({
      id: a.id,
      index: a.planIndex ?? i,
      role: a.role,
      mode: a.mode,
      status: a.status,
      prompt: a.prompt,
      agentId: a.agentId,
      agentStatus: a.agentStatus,
      failureReason: a.failureReason,
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

  /** Whether this task is running, so the 'c' cancel shortcut and hint apply. */
  get cancellable(): boolean {
    return CANCELLABLE_TASK_STATUSES.has(this.status);
  }

  /** Whether this task is waiting to be started, so the 's' shortcut and hint apply. */
  get startable(): boolean {
    return this.status === 'ready';
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

  protected renderHeading(width: number): string[] {
    return renderTaskPaneHeading(this.id, this.status, this.prompt, width);
  }
}
