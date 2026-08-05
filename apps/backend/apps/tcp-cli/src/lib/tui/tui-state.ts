// Pure pane/tab bookkeeping for the TUI — which agents are being watched,
// which tab is active, and whether the active tab may receive input. Kept
// free of any terminal-kit dependency so it's testable without a live TTY.

/** The backing assignment's identity/state, for an assignment pane's heading and tab label. */
export interface PaneAssignmentInfo {
  id: string;
  /** Null for an assignment with no plan-derived shortcode (an orphan — plain chat/consultation). */
  shortcode: string | null;
  status: string;
  prompt: string;
  /** Why the assignment failed — set only when `status` is `failed`. */
  failureReason?: string | null;
}

export interface PaneSpec {
  id: string;
  label: string;
  /** Whether the user can type to this agent (the root agent), vs. a
   * consultation-follower pane that is spectate-only. */
  talkable: boolean;
  /** The role's slug, for the pane's "Role name (and slug)" heading line. Absent for consultation-follower panes. */
  roleSlug?: string;
  /** The pane's backing assignment. Absent for consultation-follower panes (not fetched — see ChatSession.streamAgent). */
  assignment?: PaneAssignmentInfo;
}

/** A role offered by the company roster pane's "initiate chat" list. */
export interface RoleOption {
  id: string;
  name: string;
  slug: string;
}

/** One assignment as shown in a task panel's Assignments list. */
export interface AssignmentInfo {
  id: string;
  /** The assignment's role, resolved to its display name (not just an id). */
  role: string;
  /** The assignment's role's slug. */
  roleSlug: string;
  /** The kind of work — `plan`/`implement`/`qa`/`finalise` etc. — shown alongside status as `(mode: status)`. */
  mode: string;
  status: string;
  prompt: string;
  /** Null for an assignment with no plan-derived shortcode (shouldn't happen for a task's own assignments). */
  shortcode: string | null;
  /**
   * This assignment's position in the task's plan — 0 for the planning
   * assignment, an implement step's index (1-based), or (for qa) the
   * implement step it reviews — parsed from `shortcode`'s middle segment.
   * Null when `shortcode` is null (falls back to array position for display).
   */
  planIndex: number | null;
  /** The assignment's working agent, once dispatched — null before it begins. */
  agentId: string | null;
  /** Why the assignment failed — set only when `status` is `failed`. */
  failureReason: string | null;
}

/**
 * One row of a {@link SelectableList}. `render` draws it at a given content
 * width, told whether it's the current selection (e.g. the `>` marker).
 * `selectable` defaults to true — set it false for a non-interactive row
 * such as a group heading rendered as its own entry (rare; group titles are
 * usually handled by {@link ListGroup.title} instead).
 */
export interface ListEntry {
  id: string;
  render(width: number, selected: boolean): string[];
  selectable?: boolean;
}

/** A titled cluster of entries within a {@link SelectableList} (e.g. "Active" tasks). */
export interface ListGroup {
  title?: string;
  entries: ListEntry[];
}

/** One of a panel's named, groupable, selectable lists (e.g. "Roles", "Tasks"). */
export interface SelectableList {
  title: string;
  groups: ListGroup[];
}

/** A selectable row's location within a panel's lists — what `MultiListSelection.current` resolves to. */
export interface ListPosition {
  listIndex: number;
  groupIndex: number;
  entryIndex: number;
  entry: ListEntry;
}

/** Flattens a panel's lists into their selectable rows, in list/group/entry order. */
function flattenSelectable(lists: SelectableList[]): ListPosition[] {
  const flat: ListPosition[] = [];
  lists.forEach((list, listIndex) => {
    list.groups.forEach((group, groupIndex) => {
      group.entries.forEach((entry, entryIndex) => {
        if (entry.selectable ?? true) {
          flat.push({ listIndex, groupIndex, entryIndex, entry });
        }
      });
    });
  });
  return flat;
}

/**
 * Tracks a single flat selection index over every selectable row across a
 * panel's {@link SelectableList}s (skipping non-selectable rows, e.g. group
 * headings). `moveSelection` cycles top↔bottom over the whole concatenated
 * set; `jumpToList` moves to the first selectable entry of the previous/next
 * list. Kept free of any terminal-kit dependency — the panel (`RosterPane`)
 * owns rendering and calls back into this for navigation only.
 */
export class MultiListSelection {
  private lists: SelectableList[] = [];
  private index = 0;

  /** Replaces the lists, clamping the current index if the flat row count shrank. */
  setLists(lists: SelectableList[]): void {
    this.lists = lists;
    const count = flattenSelectable(lists).length;
    this.index = count === 0 ? 0 : Math.min(this.index, count - 1);
  }

  /** The currently-selected row, or undefined if there are no selectable rows. */
  get current(): ListPosition | undefined {
    return flattenSelectable(this.lists)[this.index];
  }

  /** Moves the selection by `delta` rows, cycling at either end. */
  moveSelection(delta: number): void {
    const flat = flattenSelectable(this.lists);
    if (flat.length === 0) return;
    this.index = (this.index + delta + flat.length) % flat.length;
  }

  /**
   * Moves the selection to the first selectable entry of the previous
   * (`-1`) or next (`1`) list, wrapping around and skipping any list with no
   * selectable entries. No-op with fewer than two lists.
   */
  jumpToList(direction: 1 | -1): void {
    const flat = flattenSelectable(this.lists);
    if (flat.length === 0 || this.lists.length <= 1) return;
    const n = this.lists.length;
    let target = (flat[this.index].listIndex + direction + n) % n;
    for (let tries = 0; tries < n; tries++) {
      const firstIndex = flat.findIndex((pos) => pos.listIndex === target);
      if (firstIndex !== -1) {
        this.index = firstIndex;
        return;
      }
      target = (target + direction + n) % n;
    }
  }
}

/** Tracks the set of open panes and which one is currently focused. */
export class PaneManager {
  private order: string[] = [];
  private panes = new Map<string, PaneSpec>();
  private activeId: string | null = null;

  /** Adds a pane and, if none is active yet, focuses it. */
  addPane(spec: PaneSpec): void {
    if (this.panes.has(spec.id)) return;
    this.panes.set(spec.id, spec);
    this.order.push(spec.id);
    if (this.activeId === null) this.activeId = spec.id;
  }

  /**
   * Replaces one pane's identity in place, at the same tab position — used
   * when a transient form pane (the initiate-task panel) hands off to its
   * result pane (the newly created task's panel) without appending a new tab
   * at the end. No-op if `oldId` isn't open.
   */
  replacePane(oldId: string, spec: PaneSpec): void {
    const index = this.order.indexOf(oldId);
    if (index === -1) return;
    this.panes.delete(oldId);
    this.order[index] = spec.id;
    this.panes.set(spec.id, spec);
    if (this.activeId === oldId) this.activeId = spec.id;
  }

  /** Removes a pane (e.g. a consultation follower whose agent finished). */
  removePane(id: string): void {
    if (!this.panes.has(id)) return;
    const removedIndex = this.order.indexOf(id);
    this.panes.delete(id);
    this.order.splice(removedIndex, 1);
    if (this.activeId === id) {
      const next = this.order[removedIndex] ?? this.order[removedIndex - 1];
      this.activeId = next ?? null;
    }
  }

  get panesInOrder(): PaneSpec[] {
    return this.order.map((id) => this.panes.get(id)!);
  }

  get activePane(): PaneSpec | null {
    return this.activeId ? (this.panes.get(this.activeId) ?? null) : null;
  }

  /** Whether the input box should be shown/enabled for the active tab. */
  get inputEnabled(): boolean {
    return this.activePane?.talkable ?? false;
  }

  switchTo(id: string): void {
    if (this.panes.has(id)) this.activeId = id;
  }

  /** Moves focus to the next tab, wrapping around (e.g. on Tab). */
  next(): void {
    if (this.order.length === 0) return;
    const i = this.activeId ? this.order.indexOf(this.activeId) : -1;
    this.activeId = this.order[(i + 1) % this.order.length];
  }

  /** Moves focus to the previous tab, wrapping around (e.g. on Shift+Tab). */
  prev(): void {
    if (this.order.length === 0) return;
    const i = this.activeId ? this.order.indexOf(this.activeId) : 0;
    this.activeId = this.order[(i - 1 + this.order.length) % this.order.length];
  }
}
