// Full-screen multi-agent TUI: one tab per monitored agent, independent
// scrollback per tab, and an input box shown only for talkable (chat) panes.
// Built directly on terminal-kit's Document/TextBox/InlineInput widgets (see
// terminal-kit-document.d.ts). The pane content/rendering logic itself lives
// in panes.ts (Pane/AssignmentPane/RosterPane/TextPane) — this file owns
// tabs, the hint row, the input box, and key routing across whichever pane
// is active.
//
// One pane is special: the company roster (added via addRosterPane), listing
// the company's roles with an up/down-moved highlight. It has no InlineInput,
// so arrow keys and Enter are free for list navigation and "initiate chat"
// (see handleKey's roster branch) instead of being routed to a text box.
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
import {
  Document,
  InlineInput,
  TextBox,
  terminal as sharedTerminal,
} from 'terminal-kit';
import { Renderer } from '../core/render';
import { escapeMarkup } from './tui-format';
import {
  AssignmentPane,
  InitiateTaskPane,
  InitiateTaskSubmission,
  Pane,
  RosterPane,
  TaskPane,
  TextPane,
} from './panes';
import { AssignmentInfo, PaneManager, PaneSpec, RoleOption } from './tui-state';

export type { AssignmentInfo, RoleOption } from './tui-state';
export type { InitiateTaskSubmission } from './panes';
/** Statuses for which the task panel's cancel shortcut/hint should show. */
const CANCELLABLE_TASK_STATUSES = new Set([
  'planning',
  'in-progress',
  'finalising',
]);

/** Result of interpreting one raw key-press at the terminal level. */
export type KeyAction = 'next-pane' | 'prev-pane' | 'quit' | 'none';

/**
 * Pure keybinding decision for the keys handled globally. Everything else is
 * routed by the Document to the focused widget: the input box on a talkable
 * pane (arrows/Home/End edit, Enter submits, Alt+Enter inserts a newline),
 * or the scrollback TextBox on a spectator pane (arrows/PgUp/PgDn/Home/End
 * scroll natively). Tab/Shift+Tab are safe to take for pane switching: the
 * focused InlineInput binds Tab to auto-complete, a no-op with no completer
 * configured, and TextBox doesn't bind Tab at all.
 */
export function interpretKey(name: string): KeyAction {
  if (name === 'TAB') return 'next-pane';
  if (name === 'SHIFT_TAB') return 'prev-pane';
  if (name === 'CTRL_C') return 'quit';
  return 'none';
}

/** A pane whose Up/Down keys move a flat row highlight (RosterPane, TaskPane, InitiateTaskPane). */
interface NavigableList {
  moveSelection(delta: number): void;
}

/** Type guard for {@link NavigableList} — the three panes with no InlineInput and a movable highlight. */
function isNavigableList(pane: Pane | undefined): pane is Pane & NavigableList {
  return (
    pane instanceof RosterPane ||
    pane instanceof TaskPane ||
    pane instanceof InitiateTaskPane
  );
}

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

const TAB_ROWS = 1;
/** Blank row between the tab bar and every pane's content. */
const TAB_GAP_ROWS = 1;
const CONTENT_TOP = TAB_ROWS + TAB_GAP_ROWS;
const HINT_ROWS = 1;
/** Rows reserved for the input box — it starts at 1 high and can grow to
 * this many rows via Alt+Enter before further lines draw over the hint row. */
const INPUT_ROWS = 3;

/** Narrower than this and a pane's own content (headings, wrapped text, the
 * scrollbar column) has nowhere sane to go — treated the same as "too
 * short": panes stay hidden/unpositioned, and the resize isn't forwarded to
 * terminal-kit's own Document#onEventSourceResize (see Tui's constructor). */
const MIN_CONTENT_WIDTH = 3;

/** Default max lines a highlighted company task-list entry expands to. */
const TASK_LIST_ENTRY_MAX_LINES = 4;

/**
 * Resolves `--task-list-max-lines` (precedence: CLI flag → `TCP_TASK_LIST_ENTRY_MAX_LINES`
 * env var → {@link TASK_LIST_ENTRY_MAX_LINES}), falling back to the default
 * for anything that isn't a positive integer.
 */
export function resolveTaskListEntryMaxLines(flagValue?: string): number {
  const raw = flagValue ?? process.env['TCP_TASK_LIST_ENTRY_MAX_LINES'];
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : TASK_LIST_ENTRY_MAX_LINES;
}

/** Fixed id for the (at most one) help pane; see Tui.showHelp(). */
const HELP_PANE_ID = '__help__';

/** Fixed id for the (at most one) initiate-task form pane; see Tui.addInitiateTaskPane(). */
const INITIATE_TASK_PANE_ID = '__initiate_task__';

const HELP_TEXT = [
  'Keyboard shortcuts',
  '',
  'Tab / Shift+Tab   Switch tabs',
  'Ctrl+W            Close the active tab (not the company roster)',
  'Ctrl+C            Stop watching (mid-turn), or quit (idle)',
  'F1 / Ctrl+G       Show this help; Tab, Shift+Tab, or Esc closes it',
  '                  (Ctrl+G works even where F1 is intercepted by the',
  '                  OS or terminal — e.g. bound to brightness on Macs)',
  '',
  'On the company roster:',
  '  Up / Down       Move the highlight (cycles across Roles and Tasks)',
  '  [ / ]           Jump to the previous/next list (Roles, Tasks)',
  '  Enter           Start a chat with the highlighted role, or open the',
  '                  highlighted task',
  '  r               Refresh the role list',
  '  n               Open the initiate-task form',
  '',
  'On a task panel:',
  '  Up / Down       Move the highlight (skips not-yet-begun assignments)',
  '  Enter           Open the highlighted (begun) assignment',
  '  c               Cancel the task (while it is running)',
  '  s               Start the task (while it is ready)',
  '',
  'On the initiate-task form:',
  '  Up / Down       Move the highlight',
  '  Enter           Edit the prompt/add a filename, choose the highlighted',
  '                  role, toggle "Start immediately", or submit',
  '  d               Remove the highlighted expected-output filename',
  '  (while editing) Type to enter text; Backspace deletes; Enter commits',
  '',
  'On a talkable tab:',
  '  Enter           Send the message',
  '  Alt+Enter       Insert a newline',
  '  PgUp / PgDn     Scroll the scrollback',
  "  'exit' / 'quit' Type either to end the whole session",
];

/**
 * Joins `hints` (most- to least-important) with ' · ', dropping trailing
 * ones that would overflow `width` — a narrow terminal loses the least
 * important hints first rather than silently truncating mid-word (a
 * non-wrapping single-row TextBox would otherwise just clip the tail,
 * which could as easily cut off "Ctrl+C quit" as anything else).
 */
function fitHints(hints: string[], width: number): string {
  let result = '';
  for (const hint of hints) {
    const candidate = result ? `${result} · ${hint}` : hint;
    if (candidate.length > width) break;
    result = candidate;
  }
  return result;
}

/**
 * Orchestrates the full-screen multi-pane view: one scrollback TextBox per
 * agent (or a role roster for the company pane), a tab bar, a key-hint row,
 * and an {@link InlineInput} shown only when the active pane is talkable.
 */
export class Tui {
  private readonly term: TuiTerminal;
  private readonly hideReasoning: boolean;
  private readonly taskListEntryMaxLines: number;
  private readonly document: Document;
  private readonly manager = new PaneManager();
  private readonly panes = new Map<string, Pane>();
  private readonly tabBar: TextBox;
  private readonly hintBar: TextBox;
  private input: InlineInput | null = null;
  /** Which pane's draft the current `input` widget holds, if any. */
  private inputPaneId: string | null = null;
  private submitHandler: ((message: string, paneId: string) => void) | null =
    null;
  private quitHandler: (() => void) | null = null;
  private selectRoleHandler: ((role: RoleOption) => void) | null = null;
  private refreshRosterHandler: (() => void) | null = null;
  private closeTabHandler: ((paneId: string) => void) | null = null;
  private selectTaskHandler: ((task: TaskChangeSummary) => void) | null = null;
  private selectAssignmentHandler:
    ((taskId: string, assignment: AssignmentInfo) => void) | null = null;
  private cancelTaskHandler: ((taskId: string) => void) | null = null;
  private startTaskHandler: ((taskId: string) => void) | null = null;
  private openInitiateTaskHandler: (() => void) | null = null;
  private submitInitiateTaskHandler:
    ((paneId: string, submission: InitiateTaskSubmission) => void) | null =
    null;

  constructor(opts: TuiOptions = {}) {
    this.term = opts.term ?? sharedTerminal;
    this.hideReasoning = opts.hideReasoning ?? false;
    this.taskListEntryMaxLines =
      opts.taskListEntryMaxLines ?? TASK_LIST_ENTRY_MAX_LINES;
    this.term.fullscreen(true);
    this.document = new Document({
      outputDst: opts.outputDst ?? this.term,
      eventSource: this.term,
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
      this.dropInput();
      if (this.hasRoomForContent()) {
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
    this.submitHandler = handler;
  }

  /**
   * Registers the callback fired on Ctrl+C, in place of the default
   * (stop capture, exit fullscreen, exit the process). Callers with their own
   * two-stage quit semantics (e.g. abort an in-flight turn first, only exit
   * the process on a second Ctrl+C while idle) should call {@link stop}
   * themselves when they actually intend to exit.
   */
  onQuit(handler: () => void): void {
    this.quitHandler = handler;
  }

  /** Registers the callback fired when Enter selects a role on a roster pane. */
  onSelectRole(handler: (role: RoleOption) => void): void {
    this.selectRoleHandler = handler;
  }

  /** Registers the callback fired when 'r' is pressed on a roster pane. */
  onRefreshRoster(handler: () => void): void {
    this.refreshRosterHandler = handler;
  }

  /**
   * Registers the callback fired when Ctrl+W closes a tab (the tab is
   * already removed from the TUI by the time this fires — see handleKey).
   * Never fires for the company roster pane, which can't be closed.
   */
  onCloseTab(handler: (paneId: string) => void): void {
    this.closeTabHandler = handler;
  }

  /** Registers the callback fired when Enter selects a task on a roster pane. */
  onSelectTask(handler: (task: TaskChangeSummary) => void): void {
    this.selectTaskHandler = handler;
  }

  /** Registers the callback fired when Enter selects a begun assignment on a task panel. */
  onSelectAssignment(
    handler: (taskId: string, assignment: AssignmentInfo) => void,
  ): void {
    this.selectAssignmentHandler = handler;
  }

  /** Registers the callback fired when 'c' cancels a task from its task panel. */
  onCancelTask(handler: (taskId: string) => void): void {
    this.cancelTaskHandler = handler;
  }

  /** Registers the callback fired when 's' starts a `ready` task from its task panel. */
  onStartTask(handler: (taskId: string) => void): void {
    this.startTaskHandler = handler;
  }

  /** Registers the callback fired when 'n' opens the initiate-task form from the company roster. */
  onOpenInitiateTask(handler: () => void): void {
    this.openInitiateTaskHandler = handler;
  }

  /**
   * Registers the callback fired when the initiate-task form validates and
   * submits — `paneId` is always {@link INITIATE_TASK_PANE_ID}, passed
   * through so the caller can hand off to {@link Tui.replaceWithTaskPane}.
   */
  onSubmitInitiateTask(
    handler: (paneId: string, submission: InitiateTaskSubmission) => void,
  ): void {
    this.submitInitiateTaskHandler = handler;
  }

  /** Whether a pane with this id is already open (e.g. to avoid re-adding it). */
  hasPane(id: string): boolean {
    return this.panes.has(id);
  }

  /** Adds a new tab for an agent (talkable = the user can address it directly). */
  addPane(spec: PaneSpec): void {
    if (this.panes.has(spec.id)) return;
    this.manager.addPane(spec);
    const textBox = this.createContentTextBox();
    const pane = new AssignmentPane(
      spec.id,
      spec.label,
      textBox,
      spec.talkable,
      spec.roleSlug,
      spec.assignment,
      this.hideReasoning,
    );
    this.panes.set(spec.id, pane);
    this.refresh();
  }

  /**
   * Adds the company roster pane: a spectate-only (no InlineInput) tab
   * listing the company's roles, navigated with Up/Down and Enter (see
   * handleKey). Only one roster pane is expected per session.
   */
  addRosterPane(spec: {
    id: string;
    label: string;
    slug: string;
    roles: RoleOption[];
  }): void {
    if (this.panes.has(spec.id)) return;
    const paneSpec: PaneSpec = {
      id: spec.id,
      label: spec.label,
      talkable: false,
    };
    this.manager.addPane(paneSpec);
    const textBox = this.createContentTextBox();
    const pane = new RosterPane(
      spec.id,
      spec.label,
      textBox,
      spec.slug,
      spec.roles,
      [],
      this.taskListEntryMaxLines,
    );
    this.panes.set(spec.id, pane);
    this.refresh();
  }

  /** Builds a task pane's TaskPane instance — shared by addTaskPane and replaceWithTaskPane. */
  private buildTaskPane(spec: {
    id: string;
    label: string;
    prompt: string;
    status: string;
    assignments: AssignmentInfo[];
  }): TaskPane {
    const textBox = this.createContentTextBox();
    return new TaskPane(
      spec.id,
      spec.label,
      textBox,
      spec.prompt,
      spec.status,
      spec.assignments,
      this.taskListEntryMaxLines,
    );
  }

  /**
   * Adds (or, if already open, does nothing to) a task's pane: an `Id:`/
   * `Prompt:` heading and an Assignments list, opened by selecting a task on
   * the company roster (see handleKey's roster branch) — never talkable.
   */
  addTaskPane(spec: {
    id: string;
    label: string;
    prompt: string;
    status: string;
    assignments: AssignmentInfo[];
  }): void {
    if (this.panes.has(spec.id)) return;
    this.manager.addPane({ id: spec.id, label: spec.label, talkable: false });
    this.panes.set(spec.id, this.buildTaskPane(spec));
    this.refresh();
  }

  /**
   * Replaces an open pane (the initiate-task form) with the newly created
   * task's task panel, in the same tab slot rather than appending a new tab.
   */
  replaceWithTaskPane(
    oldPaneId: string,
    spec: {
      id: string;
      label: string;
      prompt: string;
      status: string;
      assignments: AssignmentInfo[];
    },
  ): void {
    const oldPane = this.panes.get(oldPaneId);
    if (!oldPane) return;
    if (this.inputPaneId === oldPaneId) this.dropInput();
    oldPane.textBox.destroy(false, true);
    this.panes.delete(oldPaneId);
    this.manager.replacePane(oldPaneId, {
      id: spec.id,
      label: spec.label,
      talkable: false,
    });
    this.panes.set(spec.id, this.buildTaskPane(spec));
    this.refresh();
  }

  /**
   * Adds (or, if already open, switches to) the initiate-task form pane —
   * opened by 'n' from the company roster (see handleKey's roster branch).
   * At most one is ever open, at the fixed {@link INITIATE_TASK_PANE_ID}.
   */
  addInitiateTaskPane(spec: {
    companyId: string;
    roles: RoleOption[];
    defaultRoleId?: string;
  }): void {
    const id = INITIATE_TASK_PANE_ID;
    if (this.panes.has(id)) {
      this.switchToPane(id);
      return;
    }
    this.manager.addPane({ id, label: 'New task', talkable: false });
    const textBox = this.createContentTextBox();
    const pane = new InitiateTaskPane(
      id,
      'New task',
      textBox,
      spec.companyId,
      spec.roles,
      spec.defaultRoleId,
    );
    this.panes.set(id, pane);
    this.switchToPane(id);
  }

  /** Replaces a task pane's assignment list (initial fetch, or a task/assignment SSE update). */
  updateTaskPaneAssignments(
    paneId: string,
    assignments: AssignmentInfo[],
  ): void {
    const pane = this.panes.get(paneId);
    if (!(pane instanceof TaskPane)) return;
    pane.setAssignments(assignments);
    if (this.manager.activePane?.id === paneId) this.redrawActivePane();
  }

  /** Updates a task pane's own status (drives the cancel/start hint and shortcut gating). */
  updateTaskPaneStatus(paneId: string, status: string): void {
    const pane = this.panes.get(paneId);
    if (!(pane instanceof TaskPane)) return;
    pane.status = status;
    if (this.manager.activePane?.id === paneId) {
      this.renderChrome();
      this.draw();
    }
  }

  /**
   * Shows the help pane (F1 or Ctrl+G), creating it on first use and just
   * switching to it thereafter. It self-closes when the user tabs (or Esc's)
   * away — see handleKey's closeIfSelfClosing — so re-opening always starts
   * fresh.
   */
  private showHelp(): void {
    if (!this.panes.has(HELP_PANE_ID)) {
      const paneSpec: PaneSpec = {
        id: HELP_PANE_ID,
        label: 'Help',
        talkable: false,
      };
      this.manager.addPane(paneSpec);
      const textBox = this.createContentTextBox();
      this.panes.set(
        HELP_PANE_ID,
        new TextPane(HELP_PANE_ID, 'Help', textBox, HELP_TEXT),
      );
    }
    this.switchToPane(HELP_PANE_ID);
  }

  /** Replaces a roster pane's role list (e.g. the 'r' refresh key). */
  updateRosterRoles(paneId: string, roles: RoleOption[]): void {
    const pane = this.panes.get(paneId);
    if (!(pane instanceof RosterPane)) return;
    pane.setRoles(roles);
    if (this.manager.activePane?.id === paneId) this.redrawActivePane();
  }

  /** Replaces a roster pane's task list (live updates from the company SSE stream). */
  updateRosterTasks(paneId: string, tasks: TaskChangeSummary[]): void {
    const pane = this.panes.get(paneId);
    if (!(pane instanceof RosterPane)) return;
    pane.setTasks(tasks);
    if (this.manager.activePane?.id === paneId) this.redrawActivePane();
  }

  /** Removes a pane (e.g. a consultation follower whose agent finished). */
  removePane(id: string): void {
    const pane = this.panes.get(id);
    if (pane) {
      if (this.inputPaneId === id) {
        this.input?.destroy();
        this.input = null;
        this.inputPaneId = null;
      }
      pane.textBox.destroy(false, true);
      this.panes.delete(id);
    }
    this.manager.removePane(id);
    this.refresh();
  }

  /** Switches the active tab programmatically (e.g. after initiating a chat). */
  switchToPane(id: string): void {
    this.manager.switchTo(id);
    this.refresh();
  }

  /** Appends one wire event to the named pane and redraws it if active. */
  appendEvent(paneId: string, event: WireEvent): void {
    const pane = this.panes.get(paneId);
    if (!(pane instanceof AssignmentPane)) return;
    pane.appendEvent(event);
    if (this.manager.activePane?.id === paneId) this.redrawActivePane();
  }

  /**
   * Shows a transient error banner on a pane with no event log of its own
   * (roster/task/initiate-task) — redraws it if active. An AssignmentPane's
   * errors go through {@link appendEvent} instead, into its own log, so this
   * is a no-op there.
   */
  showPaneError(paneId: string, message: string): void {
    const pane = this.panes.get(paneId);
    if (!pane || pane instanceof AssignmentPane) return;
    pane.errorMessage = message;
    if (this.manager.activePane?.id === paneId) this.redrawActivePane();
  }

  /**
   * Marks one pane's turn as in flight: its input keeps accepting typed text
   * (the user can compose the next message) but Enter won't submit until the
   * turn ends, and — while this pane is active — the hint row says why.
   */
  setBusy(paneId: string, busy: boolean): void {
    const pane = this.panes.get(paneId);
    if (!(pane instanceof AssignmentPane)) return;
    pane.busy = busy;
    if (this.manager.activePane?.id === paneId) {
      if (this.input) this.input.disabled = busy;
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
    this.input?.destroy();
    this.input = null;
    this.inputPaneId = null;
    this.term.grabInput(false);
    this.term.fullscreen(false);
    // Always leave the cursor visible on exit — terminal-kit's own cleanup
    // only does this on the default Ctrl+C→processExit path, not when a
    // caller supplies its own onQuit handler and calls stop() directly.
    this.term.hideCursor(false);
  }

  /**
   * Focuses the input when a left-click lands anywhere in the rows reserved
   * for it, not just on the one row it currently occupies.
   *
   * terminal-kit only focuses an element that is itself under the pointer,
   * which leaves two dead zones a user reasonably expects to be live: the
   * `'> '` prompt (a plain TextBox child, and `TextBox.onClick` only takes
   * focus when scrollable) and the {@link INPUT_ROWS} growth rows below a
   * single-line input, which contain no element at all until Alt+Enter grows
   * into them. Both look like part of the input box on screen.
   *
   * The Document's own handler runs first (registered in its constructor),
   * so a click that already did the right thing — landing on the editable
   * area, which focuses and positions the cursor — is left alone.
   */
  private handleMouse(name: string, data: { x: number; y: number }): void {
    if (name !== 'MOUSE_LEFT_BUTTON_PRESSED') return;
    const input = this.input;
    if (!input || input.disabled || input.hasFocus) return;
    // Mouse coordinates are 1-based and document-relative; elements position
    // themselves in the Document's own 0-based space.
    const row = data.y - this.document.outputY;
    const top = input.outputY;
    if (row < top || row >= top + INPUT_ROWS) return;
    this.document.giveFocusTo(input);
    this.draw();
  }

  private handleKey(name: string): void {
    const action = interpretKey(name);
    if (action === 'next-pane' || action === 'prev-pane') {
      if (!this.closeIfSelfClosing()) {
        if (action === 'next-pane') this.manager.next();
        else this.manager.prev();
        this.refresh();
      }
      return;
    }
    if (action === 'quit') {
      if (this.quitHandler) {
        this.quitHandler();
      } else {
        this.stop();
        this.term.processExit(0);
      }
      return;
    }

    const activePane = this.activePaneWidgets();

    // While a field on the initiate-task form is being typed into, this
    // pane's own raw-key capture owns every key except Ctrl+C/quit (handled
    // above) — including ones that would otherwise be global shortcuts
    // (Esc, F1/Ctrl+G, Ctrl+W), so typing "f1" into a prompt doesn't pop up
    // help mid-sentence.
    if (activePane instanceof InitiateTaskPane && activePane.editingField) {
      if (name === 'ENTER') {
        activePane.commitEdit();
        this.redrawActivePane();
      } else if (name === 'BACKSPACE') {
        activePane.backspace();
        this.redrawActivePane();
      } else if (name.length === 1) {
        activePane.typeChar(name);
        this.redrawActivePane();
      }
      return;
    }

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
        this.closeTabHandler?.(paneId);
      }
      return;
    }

    // Up/Down move a flat row highlight the same way on every list-shaped
    // pane (no InlineInput exists on any of these, so the keys are free for
    // navigation) — handled once here rather than re-derived per pane type.
    if (isNavigableList(activePane) && (name === 'UP' || name === 'DOWN')) {
      activePane.moveSelection(name === 'UP' ? -1 : 1);
      this.redrawActivePane();
      return;
    }

    if (activePane instanceof RosterPane) {
      if (name === 'ENTER') {
        const role = activePane.selectedRole;
        if (role) {
          this.selectRoleHandler?.(role);
          return;
        }
        const task = activePane.selectedTask;
        if (task) this.selectTaskHandler?.(task);
        return;
      }
      if (name === 'r' || name === 'R') {
        this.refreshRosterHandler?.();
        return;
      }
      if (name === 'n' || name === 'N') {
        this.openInitiateTaskHandler?.();
        return;
      }
      // '[' / ']' jump the highlight to the previous/next list (Roles ↔
      // Tasks) — Tab/Shift+Tab already switch *panes*, so a distinct key is
      // needed for switching *lists* within this one pane; neither bracket
      // is bound anywhere else in this pane or the document.
      if (name === '[' || name === ']') {
        activePane.jumpList(name === '[' ? -1 : 1);
        this.redrawActivePane();
        return;
      }
      return;
    }

    if (activePane instanceof TaskPane) {
      if (name === 'ENTER') {
        const assignment = activePane.selectedAssignment;
        if (assignment) {
          this.selectAssignmentHandler?.(activePane.id, assignment);
        }
        return;
      }
      if (
        (name === 'c' || name === 'C') &&
        CANCELLABLE_TASK_STATUSES.has(activePane.status)
      ) {
        this.cancelTaskHandler?.(activePane.id);
        return;
      }
      if (name === 's' || name === 'S') {
        if (activePane.status === 'ready')
          this.startTaskHandler?.(activePane.id);
        return;
      }
      return;
    }

    if (activePane instanceof InitiateTaskPane) {
      // Reached only when not currently editing a field — see the
      // editingField intercept above.
      if (name === 'ENTER') {
        const submission = activePane.activateRow();
        if (submission) {
          this.submitInitiateTaskHandler?.(activePane.id, submission);
        }
        this.redrawActivePane();
        return;
      }
      if (name === 'd' || name === 'D') {
        activePane.removeCurrentExpected();
        this.redrawActivePane();
        return;
      }
      return;
    }

    // On a talkable pane the input holds focus, so the scrollback's native
    // PgUp/PgDn bindings never fire — page the log from here instead. On
    // spectator panes the TextBox is focused and pages itself natively.
    if (
      activePane instanceof AssignmentPane &&
      activePane.talkable &&
      (name === 'PAGE_UP' || name === 'PAGE_DOWN')
    ) {
      activePane.page(name === 'PAGE_UP' ? 1 : -1);
      this.draw();
    }
  }

  /**
   * Closes the active pane if it's one that self-closes on blur (currently:
   * the help pane only) — used for Tab/Shift+Tab/Esc. `removePane`'s own
   * "closest remaining neighbour" reassignment is the "sensible tab" the
   * user lands on afterwards. Returns whether it closed anything.
   */
  private closeIfSelfClosing(): boolean {
    const active = this.activePaneWidgets();
    if (active instanceof TextPane) {
      this.removePane(active.id);
      return true;
    }
    return false;
  }

  /** A scrollable, initially-hidden content TextBox at the pane content area — shared by addPane/addRosterPane/showHelp. */
  private createContentTextBox(): TextBox {
    return new TextBox({
      parent: this.document,
      x: 0,
      y: CONTENT_TOP,
      width: this.termWidth(),
      height: 1,
      scrollable: true,
      vScrollBar: true,
      hidden: true,
    });
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

  /**
   * Whether the terminal is tall enough to hold the input row above the hint
   * bar without overlapping the content area — false on a very short
   * terminal, in which case the input is dropped entirely (view-only layout)
   * rather than placed at an invalid/overlapping row. Re-checked on every
   * resize, so the input reappears once the terminal grows back.
   */
  private inputFits(): boolean {
    return this.termHeight() - HINT_ROWS - INPUT_ROWS > CONTENT_TOP;
  }

  /**
   * Whether the terminal has at least one row for pane content between the
   * tab bar (+ gap) and the hint bar, and is wide enough to be worth laying
   * out at all. `CONTENT_TOP` is a fixed offset, not derived from the
   * terminal size, so a terminal shorter than `CONTENT_TOP + HINT_ROWS`
   * would otherwise position (or even just size) a pane's TextBox somewhere
   * at/past the hint bar's row — every pane stays hidden and unpositioned
   * while this is false, rather than risk that.
   */
  private hasRoomForContent(): boolean {
    return (
      this.termHeight() - CONTENT_TOP - HINT_ROWS >= 1 &&
      this.termWidth() >= MIN_CONTENT_WIDTH
    );
  }

  private activePaneWidgets(): Pane | undefined {
    const active = this.manager.activePane;
    return active ? this.panes.get(active.id) : undefined;
  }

  /** Re-derives the whole screen for the current pane/tab/input state. */
  private refresh(): void {
    this.updateInput();
    this.layout();
    const activeId = this.manager.activePane?.id;
    const showContent = this.hasRoomForContent();
    for (const [id, pane] of this.panes) {
      if (showContent && id === activeId) pane.textBox.show(true);
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
    if (!this.hasRoomForContent()) return;
    const inputRows = this.input ? INPUT_ROWS : 0;
    const logHeight = Math.max(height - CONTENT_TOP - HINT_ROWS - inputRows, 1);
    for (const pane of this.panes.values()) {
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
    const active = this.manager.activePane;
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
      return p.id === active?.id ? `^+^C[ ${text} ]^:` : `^-  ${text}  ^:`;
    };
    this.tabBar.setContent(
      this.manager.panesInOrder.map(label).join('|'),
      true,
      true,
    );
    const activePane = this.activePaneWidgets();
    const isRoster = activePane instanceof RosterPane;
    const isHelp = activePane instanceof TextPane;
    const isTaskPane = activePane instanceof TaskPane;
    const isInitiateTask = activePane instanceof InitiateTaskPane;
    const busy = activePane instanceof AssignmentPane && activePane.busy;
    const closable = activePane !== undefined && !isRoster;
    // The help hint is only worth showing when help isn't already open.
    const helpHint = isHelp ? [] : ['F1/Ctrl+G help'];
    // Most- to least-important — fitHints drops from the end first, so a
    // narrow terminal loses "PgUp/PgDn scroll"/"F1/Ctrl+G help" before it
    // ever loses "Ctrl+C quit" or the pane's primary action.
    const hints = this.input
      ? [
          busy ? 'waiting for response…' : 'Enter send',
          'Ctrl+C quit',
          ...(closable ? ['Ctrl+W close'] : []),
          ...(busy ? [] : ['Alt+Enter newline']),
          'Tab switch',
          'PgUp/PgDn scroll',
          ...helpHint,
        ]
      : isRoster
        ? [
            'Enter chat',
            'Ctrl+C quit',
            'Up/Down select',
            'r refresh',
            'n new task',
            'Tab switch',
            'PgUp/PgDn scroll',
            '[/] switch list',
            ...helpHint,
          ]
        : isTaskPane
          ? [
              'Enter open',
              'Ctrl+C quit',
              ...(CANCELLABLE_TASK_STATUSES.has(activePane.status)
                ? ['c cancel']
                : []),
              ...(activePane.status === 'ready' ? ['s start'] : []),
              'Up/Down select',
              ...(closable ? ['Ctrl+W close'] : []),
              'Tab switch',
              ...helpHint,
            ]
          : isInitiateTask
            ? [
                activePane.editingField
                  ? 'Enter commit'
                  : 'Enter edit/select/submit',
                'Ctrl+C quit',
                ...(activePane.editingField ? [] : ['Up/Down select']),
                ...(activePane.editingField ? [] : ['d remove']),
                ...(closable ? ['Ctrl+W close'] : []),
                'Tab switch',
                ...helpHint,
              ]
            : [
                'Ctrl+C quit',
                ...(closable ? ['Ctrl+W close'] : []),
                ...(isHelp ? ['Esc close'] : []),
                'Tab switch',
                'PgUp/PgDn scroll',
                ...helpHint,
              ];
    this.hintBar.setContent(fitHints(hints, this.termWidth()), false, true);
  }

  /** Focuses the input when present, else the active scrollback (native scroll keys). */
  private focus(): void {
    const target = this.input ?? this.activePaneWidgets()?.textBox;
    if (target) this.document.giveFocusTo(target);
  }

  /** Re-renders the active pane's content and draws the document. */
  private redrawActivePane(): void {
    this.activePaneWidgets()?.redraw();
    this.draw();
  }

  /** Draws the document, then re-derives the real cursor's visibility — see
   * the module comment: terminal-kit doesn't hide it for plain (non-editable)
   * TextBoxes, so a stale blinking cursor from the input box would otherwise
   * linger on any pane/state that doesn't accept typed input. */
  private draw(): void {
    this.document.draw();
    this.term.hideCursor(!this.input || this.input.disabled);
  }

  /** Stashes the outgoing pane's draft and destroys the input (recreated by updateInput). */
  private dropInput(): void {
    if (!this.input) return;
    if (this.inputPaneId) {
      const prevPane = this.panes.get(this.inputPaneId);
      if (prevPane instanceof AssignmentPane)
        prevPane.draft = this.input.getValue();
    }
    this.input.destroy();
    this.input = null;
    this.inputPaneId = null;
  }

  /**
   * Creates or destroys the input box when the active pane's talkability (or
   * identity, with multiple talkable panes) changes. Each pane's draft and
   * busy state survive round-trips through other panes.
   */
  private updateInput(): void {
    const active = this.manager.activePane;
    // A too-short terminal drops the input even on a talkable pane (view-only
    // layout) rather than place it at an invalid/overlapping row — see
    // inputFits(). refresh() re-runs this on every resize, so it reappears
    // once the terminal grows back.
    const shouldShow = this.manager.inputEnabled && this.inputFits();
    if (!shouldShow) {
      this.dropInput();
      return;
    }
    if (this.input && this.inputPaneId === active?.id) return;
    this.dropInput();
    const pane = this.panes.get(active!.id);
    if (!(pane instanceof AssignmentPane)) return; // inputEnabled implies a talkable AssignmentPane
    this.input = new InlineInput({
      parent: this.document,
      x: 0,
      // Constructed at its final position: InlineInput's '> ' prompt is a
      // separate TextBox placed at construction coordinates only, so this
      // element cannot be repositioned later (see the resize handler).
      y: this.termHeight() - HINT_ROWS - INPUT_ROWS,
      width: this.termWidth(),
      value: pane.draft,
      prompt: { content: '> ' },
    });
    this.inputPaneId = pane.id;
    // Alt+Enter inserts a line break. Shift+Enter can't: classic terminals
    // send the same byte for Enter and Shift+Enter, so they're
    // indistinguishable here.
    this.input.keyBindings = {
      ...this.input.keyBindings,
      ALT_ENTER: 'newLine',
    };
    this.input.disabled = pane.busy;
    this.input.on('submit', (value) => {
      const message = typeof value === 'string' ? value.trim() : '';
      pane.draft = '';
      this.input?.setValue('', true);
      this.redrawActivePane();
      if (message) this.submitHandler?.(message, pane.id);
    });
  }
}

/**
 * Installs a last-resort safety net for the life of a TUI session: an
 * exception thrown from a terminal-kit event handler (a raw `EventEmitter`
 * callback several stack frames removed from any of this codebase's own
 * try/catches — e.g. a key handler driving a pane's render) would otherwise
 * crash the process without ever restoring the terminal, since only
 * {@link Tui.stop} sends the escape sequences that exit the alternate screen
 * buffer and release raw input. Left stuck, many terminal emulators then
 * read mouse-wheel scroll as arrow keys, which the shell's readline takes as
 * history navigation instead of scrolling — the "terminal looks broken after
 * a crash" symptom this closes off. Returns an uninstall function; call it
 * once the session ends normally, so a later, unrelated crash (a different
 * command entirely, in the same process) doesn't reach a stale handler.
 */
export function installCrashSafetyNet(tui: Tui): () => void {
  const onCrash = (err: unknown): void => {
    tui.stop();
    process.stderr.write(
      `Error: ${String(err instanceof Error ? err.message : err)}\n`,
    );
    process.exit(1);
  };
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);
  return () => {
    process.off('uncaughtException', onCrash);
    process.off('unhandledRejection', onCrash);
  };
}

/**
 * Adapts a {@link Tui} pane to the {@link Renderer} interface `chat.ts`'s
 * existing `streamAgent`/`runTurn` control flow already drives — this is what
 * lets that flow stay unchanged between TUI and piped-output modes; only
 * which `Renderer` gets constructed differs.
 */
export function tuiRenderer(tui: Tui, paneId: string): Renderer {
  let responseSeen = false;
  return {
    render(event: WireEvent): void {
      if (event.type === 'stream' && event.channel === 'response') {
        responseSeen = true;
      }
      tui.appendEvent(paneId, event);
    },
    get responseSeen() {
      return responseSeen;
    },
    finish(): void {
      // Panes have no open-block state to flush; event-driven redraws already
      // reflect the latest content.
    },
  };
}
