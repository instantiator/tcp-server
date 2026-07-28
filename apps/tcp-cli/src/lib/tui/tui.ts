// Full-screen multi-agent TUI: one tab per monitored agent, independent
// scrollback per tab, and an input box shown only for talkable (chat) panes.
// Built directly on terminal-kit's Document/TextBox/InlineInput widgets (see
// terminal-kit-document.d.ts).
//
// This file owns the screen: the Document, the tab and hint bars, the layout,
// and the drawing. Everything else lives beside it —
//   panes/          one module per pane class (content and scroll behaviour)
//   pane-registry   which panes exist, their tab order and their TextBoxes
//   tui-input       the InlineInput's lifecycle and draft handling
//   tui-keys        keystroke interpretation and per-pane routing
//   tui-hints       the key-hint row's content
//   tui-layout      the row budget and geometry
//   tui-help        the help overlay's text
//
// What's left is deliberately one file, and over aislop's 400-line limit: the
// Document, its widgets, the layout pass and the draw are a single lifecycle,
// and every rule in the terminal-kit warning below is about the order those
// happen in. Splitting them across collaborators would scatter that ordering,
// and the failure mode is a screen that renders nothing — which no type
// checker catches. Readability wins over the line count here.
//
// One pane is special: the company roster (added via addRosterPane), listing
// the company's roles with an up/down-moved highlight. It has no InlineInput,
// so arrow keys and Enter are free for list navigation and "initiate chat"
// instead of being routed to a text box.
//
// Another is the help pane (TextPane, opened with F1 or Ctrl+G — the latter
// since F1 is frequently intercepted before it reaches the terminal, e.g.
// bound to brightness on Mac laptops): fixed text, no input, and
// self-closing — Tab/Shift+Tab/Esc away from it removes it rather than just
// switching away, so it never lingers as a normal tab (see handleKey's
// closeIfSelfClosing).
//
// Layout, top to bottom:
//   row 0                        — tab bar
//   row 1                        — blank (TAB_GAP_ROWS)
//   rows 2..                     — the active pane's scrollback (TextBox),
//                                   itself opening with an assignment-pane
//                                   heading (or, on the roster, "Slug/Id" +
//                                   prompt, or on a task pane "Task id:" +
//                                   "Status:" + "Prompt:")
//   3 rows (talkable panes only) — input box ('> ' prompt; Alt+Enter grows it)
//   last row                     — key hints
//
// Testability: the constructor accepts a `term` (size + key/resize event
// source) and an `outputDst` draw-target override, so specs can drive the
// REAL widgets off-screen — synthetic 'key' events in, a ScreenBuffer
// character dump out. No fake widget classes: faking terminal-kit's widget
// API is exactly how the original, never-rendering implementation slipped
// past its tests.
//
// Colour: pane/roster content and the tab bar render with terminal-kit's
// caret markup enabled (grey reasoning blocks, a bold/bright active tab, an
// inverted '>' marking the roster's highlighted role). Any text we didn't
// author ourselves — reasoning/response deltas, role and company names — is
// escaped via tui-format's escapeMarkup() first, or a literal '^' in that
// text would be misread as a markup code.
//
// Cursor: terminal-kit only ever hides/positions the real terminal cursor
// via a focused *editable* widget's own drawSelfCursor (EditableTextBox);
// plain TextBoxes (the roster, spectator panes) have none, so the cursor
// last drawn by the InlineInput would otherwise linger, stale, wherever it
// was when focus moved away. draw() re-derives cursor visibility on every
// redraw instead of trusting terminal-kit's default (hidden unless the
// active pane has an *enabled* InlineInput).
//
// Ctrl+W closes the active tab (any pane except the roster, which is
// permanent); see handleKey and onCloseTab.

import type { TaskChangeSummary, WireEvent } from '@tcp/shared';
import { Document, TextBox, terminal as sharedTerminal } from 'terminal-kit';
import {
  INITIATE_TASK_PANE_ID,
  PaneRegistry,
  TaskPaneSpec,
} from './pane-registry';
import { AssignmentPane } from './panes/assignment-pane';
import { InitiateTaskSubmission } from './panes/initiate-task-pane';
import { RosterPane } from './panes/roster-pane';
import { TaskPane } from './panes/task-pane';
import { TextPane } from './panes/text-pane';
import { escapeMarkup } from './tui-format';
import { HELP_PANE_ID } from './tui-help';
import { fitHints, paneHints } from './tui-hints';
import { InputBox } from './tui-input';
import {
  dispatchInitiateTaskEdit,
  dispatchPaneKey,
  interpretKey,
  PaneKeyEffects,
  TuiHandlers,
} from './tui-keys';
import {
  CONTENT_TOP,
  contentHeight,
  HINT_ROWS,
  hasRoomForContent,
  inputFits,
  inputTop,
  TAB_ROWS,
} from './tui-layout';
import { AssignmentInfo, PaneSpec, RoleOption } from './tui-state';

export type { AssignmentInfo, RoleOption } from './tui-state';
export type { InitiateTaskSubmission } from './panes/initiate-task-pane';

/**
 * The structural slice of terminal-kit's Terminal that {@link Tui} drives —
 * also what the spec's fake implements (an EventEmitter with a size).
 */
export interface TuiTerminal {
  width: number;
  height: number;
  fullscreen(on: boolean): void;
  grabInput(on: boolean | Record<string, unknown>): void;
  processExit(code: number): void;
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  off(event: string, handler: (...args: unknown[]) => void): unknown;
  /** Shows/hides the terminal's own blinking cursor (see Tui's cursor-visibility note above). */
  hideCursor(hidden: boolean): void;
}

export interface TuiOptions {
  term?: TuiTerminal;
  /** Where the Document draws; defaults to `term`. Specs pass a ScreenBuffer. */
  outputDst?: unknown;
  hideReasoning?: boolean;
  /** Max lines a highlighted company task-list entry expands to. See {@link resolveTaskListEntryMaxLines}. */
  taskListEntryMaxLines?: number;
}

/** Default max lines a highlighted company task-list entry expands to. */
const TASK_LIST_ENTRY_MAX_LINES = 4;

/**
 * Resolves `--task-list-max-lines`, falling back to the default for anything
 * that isn't a positive integer.
 *
 * Precedence: CLI flag → `TCP_TASK_LIST_ENTRY_MAX_LINES` env var →
 * {@link TASK_LIST_ENTRY_MAX_LINES}.
 */
export function resolveTaskListEntryMaxLines(flagValue?: string): number {
  const raw = flagValue ?? process.env['TCP_TASK_LIST_ENTRY_MAX_LINES'];
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : TASK_LIST_ENTRY_MAX_LINES;
}

/**
 * Orchestrates the full-screen multi-pane view: one scrollback TextBox per
 * agent (or a role roster for the company pane), a tab bar, a key-hint row,
 * and an input box shown only when the active pane is talkable.
 */
export class Tui {
  private readonly term: TuiTerminal;
  private readonly document: Document;
  private readonly registry: PaneRegistry;
  private readonly inputBox: InputBox;
  private readonly tabBar: TextBox;
  private readonly hintBar: TextBox;
  /** The callbacks registered through this class's `onX` methods. */
  private readonly handlers: TuiHandlers = {};
  /** What key routing is allowed to ask of this class — see {@link dispatchPaneKey}. */
  private readonly keyEffects: PaneKeyEffects = {
    redrawActivePane: () => this.redrawActivePane(),
    draw: () => this.draw(),
  };

  constructor(opts: TuiOptions = {}) {
    this.term = opts.term ?? sharedTerminal;
    this.term.fullscreen(true);
    this.document = new Document({
      outputDst: opts.outputDst ?? this.term,
      eventSource: this.term,
    });
    this.registry = new PaneRegistry(
      this.document,
      () => this.termWidth(),
      opts.hideReasoning ?? false,
      opts.taskListEntryMaxLines ?? TASK_LIST_ENTRY_MAX_LINES,
    );
    this.inputBox = new InputBox(this.document, (message, paneId) => {
      this.redrawActivePane();
      if (message) this.handlers.submit?.(message, paneId);
    });
    // Document's own constructor just grabbed input in 'motion' mouse mode
    // (unconditionally, with no option to opt out — see terminal-kit's
    // Container.js) — the terminal streams a mouse-report escape sequence on
    // every pixel of cursor movement, not just clicks. Nothing here uses
    // hover/drag; downgrading to 'button' (press/release only, still enough
    // for click-to-focus and click-to-position-cursor in the input) cuts
    // that traffic, which on some terminals/multiplexers has been observed
    // to interleave with and corrupt a keypress sent shortly after a new
    // pane's input gains focus (a real keystroke silently swallowed once,
    // recovering after any subsequent mouse click resets the parser).
    this.term.grabInput({ mouse: 'button' });
    // The Document's own Tab binding cycles focus across every element (tab
    // bar and hidden panes included) — disable it; Tab is a pane switch here.
    this.document.keyBindings = {};
    this.tabBar = new TextBox({
      parent: this.document,
      x: 0,
      y: 0,
      width: this.termWidth(),
      height: TAB_ROWS,
    });
    this.hintBar = new TextBox({
      parent: this.document,
      x: 0,
      y: Math.max(this.termHeight() - HINT_ROWS, 0),
      width: this.termWidth(),
      height: HINT_ROWS,
    });
    this.term.on('key', (name) => this.handleKey(name as string));
    this.term.on('mouse', (name, data) =>
      this.handleMouse(name as string, data as { x: number; y: number }),
    );

    // terminal-kit's own Document#onEventSourceResize (registered on `term`
    // inside the Document constructor above, so it fires *before* anything
    // we add below) resizes the Document's own internal compositing buffer
    // to the raw, unclamped (width, height) and immediately redraws — using
    // whatever positions our widgets were last set to. On a resize to a
    // small/degenerate terminal, that draw runs before we ever get a chance
    // to shrink/reposition our widgets for the new size, and can throw
    // (ScreenBuffer offset out of range) — one half of the crash this
    // section fixes. Un-registering it and driving it ourselves lets us
    // guard that call: only forward the resize to Document at all when
    // there's room for content; while there isn't, Document keeps
    // compositing at its last good size (harmless — every content pane is
    // hidden during this window anyway, see refresh()), and picks up the
    // real size cleanly on the first resize event after the terminal grows
    // back, with no broken intermediate state to recover from — shrinking
    // Document's own internal buffer down to a "no content room" size (see
    // hasRoomForContent()), even transiently, has been observed to corrupt
    // it such that a *later* resize back up to a normal size then throws
    // the same error.
    //
    // The other half: forwarding to Document's own onEventSourceResize
    // (rather than just resizing its buffer) draws immediately, as part of
    // that same call — before our own layout() below has repositioned any
    // widget for the new size. Drawing those still-stale positions (a
    // pane's TextBox, or its vScrollBar Slider) into a newly (larger)
    // buffer can throw "offset out of range" from deep inside terminal-kit's
    // blitter — this is what a growing resize hit (shrinking never did,
    // since hasRoomForContent() already suppressed the forward-to-Document
    // call in that direction). Document#resize (Container's, inherited —
    // see terminal-kit-document.d.ts) only resizes the buffer and draws
    // nothing; refresh() below repositions every widget for the new size
    // and performs the first draw once everything agrees on it.
    // documentOnResize is already bound to the Document instance in its own
    // constructor — reuse that exact reference so `off` removes the
    // listener terminal-kit registered, not a new (different) bound copy.
    const documentOnResize = this.document.onEventSourceResize;
    this.term.off('resize', documentOnResize);
    this.term.on('resize', () => {
      // The input must be rebuilt, not repositioned: InlineInput places its
      // prompt TextBox at construction coordinates only, so a later
      // setSizeAndPosition would move the editable area but leave the '> '
      // prompt behind. refresh() recreates it at the new position.
      this.inputBox.drop();
      if (this.hasRoom()) {
        this.document.resize({
          x: 0,
          y: 0,
          width: this.term.width,
          height: this.term.height,
        });
      }
      this.refresh();
    });
  }

  /** Registers the callback fired when the user submits a message on some pane. */
  onSubmit(handler: (message: string, paneId: string) => void): void {
    this.handlers.submit = handler;
  }

  /**
   * Registers the callback fired on Ctrl+C, in place of the default (stop
   * capture, exit fullscreen, exit the process).
   *
   * NB. callers with their own two-stage quit semantics (e.g. abort an
   * in-flight turn first, only exit the process on a second Ctrl+C while idle)
   * should call {@link stop} themselves when they actually intend to exit.
   */
  onQuit(handler: () => void): void {
    this.handlers.quit = handler;
  }

  /** Registers the callback fired when Enter selects a role on a roster pane. */
  onSelectRole(handler: (role: RoleOption) => void): void {
    this.handlers.selectRole = handler;
  }

  /** Registers the callback fired when 'r' is pressed on a roster pane. */
  onRefreshRoster(handler: () => void): void {
    this.handlers.refreshRoster = handler;
  }

  /**
   * Registers the callback fired when Ctrl+W closes a tab.
   *
   * NB. the tab is already removed from the TUI by the time this fires (see
   * handleKey), and it never fires for the company roster pane, which can't be
   * closed.
   */
  onCloseTab(handler: (paneId: string) => void): void {
    this.handlers.closeTab = handler;
  }

  /** Registers the callback fired when Enter selects a task on a roster pane. */
  onSelectTask(handler: (task: TaskChangeSummary) => void): void {
    this.handlers.selectTask = handler;
  }

  /** Registers the callback fired when Enter selects a begun assignment on a task panel. */
  onSelectAssignment(
    handler: (taskId: string, assignment: AssignmentInfo) => void,
  ): void {
    this.handlers.selectAssignment = handler;
  }

  /** Registers the callback fired when 'c' cancels a task from its task panel. */
  onCancelTask(handler: (taskId: string) => void): void {
    this.handlers.cancelTask = handler;
  }

  /** Registers the callback fired when 's' starts a `ready` task from its task panel. */
  onStartTask(handler: (taskId: string) => void): void {
    this.handlers.startTask = handler;
  }

  /** Registers the callback fired when 'n' opens the initiate-task form from the company roster. */
  onOpenInitiateTask(handler: () => void): void {
    this.handlers.openInitiateTask = handler;
  }

  /**
   * Registers the callback fired when the initiate-task form validates and
   * submits.
   *
   * NB. `paneId` is always {@link INITIATE_TASK_PANE_ID}, passed through so the
   * caller can hand off to {@link Tui.replaceWithTaskPane}.
   */
  onSubmitInitiateTask(
    handler: (paneId: string, submission: InitiateTaskSubmission) => void,
  ): void {
    this.handlers.submitInitiateTask = handler;
  }

  /** Whether a pane with this id is already open (e.g. to avoid re-adding it). */
  hasPane(id: string): boolean {
    return this.registry.has(id);
  }

  /** Adds a new tab for an agent (talkable = the user can address it directly). */
  addPane(spec: PaneSpec): void {
    this.registry.addAssignment(spec);
    this.refresh();
  }

  /**
   * Adds the company roster pane: a spectate-only (no input box) tab listing
   * the company's roles, navigated with Up/Down and Enter (see handleKey).
   * Only one roster pane is expected per session.
   */
  addRosterPane(spec: {
    id: string;
    label: string;
    slug: string;
    roles: RoleOption[];
  }): void {
    this.registry.addRoster(spec);
    this.refresh();
  }

  /**
   * Adds (or, if already open, does nothing to) a task's pane: an `Id:`/
   * `Prompt:` heading and an Assignments list, opened by selecting a task on
   * the company roster (see handleKey's roster branch) — never talkable.
   */
  addTaskPane(spec: TaskPaneSpec): void {
    this.registry.addTask(spec);
    this.refresh();
  }

  /**
   * Replaces an open pane (the initiate-task form) with the newly created
   * task's task panel, in the same tab slot rather than appending a new tab.
   */
  replaceWithTaskPane(oldPaneId: string, spec: TaskPaneSpec): void {
    if (!this.registry.has(oldPaneId)) return;
    if (this.inputBox.isFor(oldPaneId)) this.inputBox.drop();
    this.registry.replaceWithTask(oldPaneId, spec);
    this.refresh();
  }

  /**
   * Adds (or, if already open, switches to) the initiate-task form pane —
   * opened by 'n' from the company roster (see handleKey's roster branch).
   */
  addInitiateTaskPane(spec: {
    companyId: string;
    roles: RoleOption[];
    defaultRoleId?: string;
  }): void {
    this.registry.ensureInitiateTask(spec);
    this.switchToPane(INITIATE_TASK_PANE_ID);
  }

  /** Replaces a task pane's assignment list (initial fetch, or a task/assignment SSE update). */
  updateTaskPaneAssignments(
    paneId: string,
    assignments: AssignmentInfo[],
  ): void {
    const pane = this.registry.get(paneId);
    if (!(pane instanceof TaskPane)) return;
    pane.setAssignments(assignments);
    this.redrawIfActive(paneId);
  }

  /** Updates a task pane's own status (drives the cancel/start hint and shortcut gating). */
  updateTaskPaneStatus(paneId: string, status: string): void {
    const pane = this.registry.get(paneId);
    if (!(pane instanceof TaskPane)) return;
    pane.status = status;
    if (this.isActive(paneId)) {
      this.renderChrome();
      this.draw();
    }
  }

  /** Replaces a roster pane's role list (e.g. the 'r' refresh key). */
  updateRosterRoles(paneId: string, roles: RoleOption[]): void {
    const pane = this.registry.get(paneId);
    if (!(pane instanceof RosterPane)) return;
    pane.setRoles(roles);
    this.redrawIfActive(paneId);
  }

  /** Replaces a roster pane's task list (live updates from the company SSE stream). */
  updateRosterTasks(paneId: string, tasks: TaskChangeSummary[]): void {
    const pane = this.registry.get(paneId);
    if (!(pane instanceof RosterPane)) return;
    pane.setTasks(tasks);
    this.redrawIfActive(paneId);
  }

  /** Removes a pane (e.g. a consultation follower whose agent finished). */
  removePane(id: string): void {
    if (this.inputBox.isFor(id)) this.inputBox.drop();
    this.registry.remove(id);
    this.refresh();
  }

  /** Switches the active tab programmatically (e.g. after initiating a chat). */
  switchToPane(id: string): void {
    this.registry.switchTo(id);
    this.refresh();
  }

  /** Appends one wire event to the named pane and redraws it if active. */
  appendEvent(paneId: string, event: WireEvent): void {
    const pane = this.registry.get(paneId);
    if (!(pane instanceof AssignmentPane)) return;
    pane.appendEvent(event);
    this.redrawIfActive(paneId);
  }

  /**
   * Shows a transient error banner on a pane with no event log of its own
   * (roster/task/initiate-task) — redraws it if active.
   *
   * NB. an {@link AssignmentPane}'s errors go through {@link appendEvent}
   * instead, into its own log, so this is a no-op there.
   */
  showPaneError(paneId: string, message: string): void {
    const pane = this.registry.get(paneId);
    if (!pane || pane instanceof AssignmentPane) return;
    pane.errorMessage = message;
    this.redrawIfActive(paneId);
  }

  /**
   * Marks one pane's turn as in flight: its input keeps accepting typed text
   * (the user can compose the next message) but Enter won't submit until the
   * turn ends, and — while this pane is active — the hint row says why.
   */
  setBusy(paneId: string, busy: boolean): void {
    const pane = this.registry.get(paneId);
    if (!(pane instanceof AssignmentPane)) return;
    pane.busy = busy;
    if (this.isActive(paneId)) {
      this.inputBox.disabled = busy;
      // Hand focus back when the turn ends: a disabled InlineInput is skipped
      // by the Document's focus handling, so without this the user has to
      // click the box before they can type the next message.
      if (!busy) this.focus();
      this.renderChrome();
      this.draw();
    }
  }

  /** Tears down fullscreen/input capture, restoring the normal terminal. */
  stop(): void {
    this.inputBox.drop();
    this.term.grabInput(false);
    this.term.fullscreen(false);
    // Always leave the cursor visible on exit — terminal-kit's own cleanup
    // only does this on the default Ctrl+C→processExit path, not when a
    // caller supplies its own onQuit handler and calls stop() directly.
    this.term.hideCursor(false);
  }

  private handleMouse(name: string, data: { x: number; y: number }): void {
    if (name !== 'MOUSE_LEFT_BUTTON_PRESSED') return;
    // Mouse coordinates are 1-based and document-relative; elements position
    // themselves in the Document's own 0-based space.
    if (this.inputBox.focusOnClickIn(data.y - this.document.outputY)) {
      this.draw();
    }
  }

  private handleKey(name: string): void {
    const action = interpretKey(name);
    if (action === 'next-pane' || action === 'prev-pane') {
      if (!this.closeIfSelfClosing()) {
        if (action === 'next-pane') this.registry.next();
        else this.registry.prev();
        this.refresh();
      }
      return;
    }
    if (action === 'quit') {
      if (this.handlers.quit) {
        this.handlers.quit();
      } else {
        this.stop();
        this.term.processExit(0);
      }
      return;
    }

    const activePane = this.registry.active;

    // A field being typed into on the initiate-task form claims every
    // remaining key, including the global shortcuts below.
    if (dispatchInitiateTaskEdit(activePane, name, this.keyEffects)) return;

    // Esc is the other way to dismiss a self-closing pane (Tab/Shift+Tab —
    // handled above — being the primary one). No-op on every other pane.
    if (name === 'ESCAPE') {
      this.closeIfSelfClosing();
      return;
    }

    // Ctrl+G is a second way in: F1 is frequently intercepted before it ever
    // reaches the terminal (e.g. bound to brightness on Mac laptops unless
    // Fn is held), so help shouldn't depend on F1 alone getting through.
    if (name === 'F1' || name === 'CTRL_G') {
      this.showHelp();
      return;
    }

    // Ctrl+W closes any tab except the company roster, which is the
    // permanent anchor — closing the last agent tab just leaves you back
    // on the roster, the same state --company-id-only starts in.
    if (name === 'CTRL_W') {
      if (activePane && !(activePane instanceof RosterPane)) {
        const paneId = activePane.id;
        this.removePane(paneId);
        this.handlers.closeTab?.(paneId);
      }
      return;
    }

    dispatchPaneKey(activePane, name, this.handlers, this.keyEffects);
  }

  /**
   * Shows the help pane (F1 or Ctrl+G), creating it on first use and just
   * switching to it thereafter.
   */
  private showHelp(): void {
    this.registry.ensureHelp();
    this.switchToPane(HELP_PANE_ID);
  }

  /**
   * Closes the active pane if it's one that self-closes on blur (currently:
   * the help pane only) — used for Tab/Shift+Tab/Esc. Returns whether it
   * closed anything.
   *
   * NB. `removePane`'s own "closest remaining neighbour" reassignment is the
   * "sensible tab" the user lands on afterwards.
   */
  private closeIfSelfClosing(): boolean {
    const active = this.registry.active;
    if (active instanceof TextPane) {
      this.removePane(active.id);
      return true;
    }
    return false;
  }

  /** Whether the named pane is the active tab. */
  private isActive(paneId: string): boolean {
    return this.registry.activeSpec?.id === paneId;
  }

  /** Redraws the named pane, if it is the one on screen. */
  private redrawIfActive(paneId: string): void {
    if (this.isActive(paneId)) this.redrawActivePane();
  }

  /** The terminal's current width, clamped ≥ 1 — a resize can momentarily
   * report 0 (terminal-kit's degenerate-size default) before a real size
   * follows; every widget size/position derives from this rather than
   * `this.term.width` directly. */
  private termWidth(): number {
    return Math.max(this.term.width, 1);
  }

  /** The terminal's current height, clamped ≥ 1 — see {@link termWidth}. */
  private termHeight(): number {
    return Math.max(this.term.height, 1);
  }

  /** Whether the terminal is big enough to lay content out at all. */
  private hasRoom(): boolean {
    return hasRoomForContent(this.termWidth(), this.termHeight());
  }

  /** Re-derives the whole screen for the current pane/tab/input state. */
  private refresh(): void {
    this.updateInput();
    this.layout();
    const activeId = this.registry.activeSpec?.id;
    const showContent = this.hasRoom();
    for (const pane of this.registry.all) {
      if (showContent && pane.id === activeId) pane.textBox.show(true);
      else pane.textBox.hide(true);
    }
    this.renderChrome();
    this.focus();
    if (showContent) {
      this.redrawActivePane();
    } else {
      // No content pane is shown/positioned (see layout()) — just the tab
      // and hint bars, which are always exactly 1 row each and safe.
      this.draw();
    }
  }

  /** Positions every widget for the current terminal size and input presence. */
  private layout(): void {
    const width = this.termWidth();
    const height = this.termHeight();
    this.tabBar.setSizeAndPosition({ x: 0, y: 0, width, height: TAB_ROWS });
    this.hintBar.setSizeAndPosition({
      x: 0,
      y: Math.max(height - HINT_ROWS, 0),
      width,
      height: HINT_ROWS,
    });
    // Too short to fit even one content row without overlapping the hint
    // bar — leave every pane's TextBox at its last known (safe) size/position
    // and hidden (see refresh()); repositioning it into an invalid row is
    // exactly the crash this guards against.
    if (!this.hasRoom()) return;
    const logHeight = contentHeight(height, this.inputBox.present);
    for (const pane of this.registry.all) {
      pane.textBox.setSizeAndPosition({
        x: 0,
        y: CONTENT_TOP,
        width,
        height: logHeight,
      });
    }
  }

  /** Renders the tab bar and the key-hint row (content only; no draw). */
  private renderChrome(): void {
    const activeId = this.registry.activeSpec?.id;
    // Bold bright cyan (^+^C) for the active tab, dim (^-) for the rest;
    // labels are escaped since they're role/company names, not our own text.
    const label = (p: PaneSpec) => {
      // An assignment pane with a shortcode shows that instead of its role
      // name — a task pane's own label is already `Task: ${shortcode}` (set
      // by the caller — see wiring.ts), so this only ever fires for
      // assignment panes.
      const text = escapeMarkup(
        p.assignment?.shortcode
          ? `Assignment: ${p.assignment.shortcode}`
          : p.label,
      );
      return p.id === activeId ? `^+^C[ ${text} ]^:` : `^-  ${text}  ^:`;
    };
    this.tabBar.setContent(
      this.registry.specsInOrder.map(label).join('|'),
      true,
      true,
    );
    this.hintBar.setContent(
      fitHints(
        paneHints(this.registry.active, this.inputBox.present),
        this.termWidth(),
      ),
      false,
      true,
    );
  }

  /** Focuses the input when present, else the active scrollback (native scroll keys). */
  private focus(): void {
    const target = this.inputBox.element ?? this.registry.active?.textBox;
    if (target) this.document.giveFocusTo(target);
  }

  /** Re-renders the active pane's content and draws the document. */
  private redrawActivePane(): void {
    this.registry.active?.redraw();
    this.draw();
  }

  /** Draws the document, then re-derives the real cursor's visibility — see
   * the module comment: terminal-kit doesn't hide it for plain (non-editable)
   * TextBoxes, so a stale blinking cursor from the input box would otherwise
   * linger on any pane/state that doesn't accept typed input. */
  private draw(): void {
    this.document.draw();
    this.term.hideCursor(!this.inputBox.present || this.inputBox.disabled);
  }

  /**
   * Creates or destroys the input box when the active pane's talkability (or
   * identity, with multiple talkable panes) changes. Each pane's draft and
   * busy state survive round-trips through other panes.
   *
   * NB. a too-short terminal drops the input even on a talkable pane (a
   * view-only layout) rather than place it at an invalid or overlapping row.
   * refresh() re-runs this on every resize, so it reappears once the terminal
   * grows back.
   */
  private updateInput(): void {
    if (!this.registry.inputEnabled || !inputFits(this.termHeight())) {
      this.inputBox.drop();
      return;
    }
    const pane = this.registry.active;
    // inputEnabled implies a talkable AssignmentPane.
    if (!(pane instanceof AssignmentPane)) return;
    this.inputBox.ensureFor(
      pane,
      inputTop(this.termHeight()),
      this.termWidth(),
    );
  }
}
