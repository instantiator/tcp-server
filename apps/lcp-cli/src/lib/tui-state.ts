// Pure pane/tab bookkeeping for the TUI — which agents are being watched,
// which tab is active, and whether the active tab may receive input. Kept
// free of any terminal-kit dependency so it's testable without a live TTY.

export interface PaneSpec {
  id: string;
  label: string;
  /** Whether the user can type to this agent (the root agent), vs. a
   * consultation-follower pane that is spectate-only. */
  talkable: boolean;
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
