// Keystroke interpretation for the TUI: which keys the Tui itself claims, and
// how the rest are routed into the active pane's own behaviour. Pure routing —
// {@link Tui} supplies the effects and the registered callbacks.

import type { TaskChangeSummary } from '@tcp/shared';
import { AssignmentPane } from './panes/assignment-pane';
import {
  InitiateTaskPane,
  InitiateTaskSubmission,
} from './panes/initiate-task-pane';
import { Pane } from './panes/pane';
import { RosterPane } from './panes/roster-pane';
import { TaskPane } from './panes/task-pane';
import { AssignmentInfo, RoleOption } from './tui-state';

/** Result of interpreting one raw key-press at the terminal level. */
export type KeyAction = 'next-pane' | 'prev-pane' | 'quit' | 'none';

/**
 * Pure keybinding decision for the keys handled globally.
 *
 * Everything else is routed by the Document to the focused widget: the input
 * box on a talkable pane (arrows/Home/End edit, Enter submits, Alt+Enter
 * inserts a newline), or the scrollback TextBox on a spectator pane
 * (arrows/PgUp/PgDn/Home/End scroll natively).
 *
 * NB. Tab/Shift+Tab are safe to take for pane switching: the focused
 * InlineInput binds Tab to auto-complete, a no-op with no completer
 * configured, and TextBox doesn't bind Tab at all.
 */
export function interpretKey(name: string): KeyAction {
  if (name === 'TAB') return 'next-pane';
  if (name === 'SHIFT_TAB') return 'prev-pane';
  if (name === 'CTRL_C') return 'quit';
  return 'none';
}

/** A pane whose Up/Down keys move a flat row highlight. */
interface NavigableList {
  moveSelection(delta: number): void;
}

/**
 * Type guard for {@link NavigableList} — the three panes with no InlineInput
 * and a movable highlight.
 */
function isNavigableList(pane: Pane | undefined): pane is Pane & NavigableList {
  return (
    pane instanceof RosterPane ||
    pane instanceof TaskPane ||
    pane instanceof InitiateTaskPane
  );
}

/**
 * Every callback a caller can register on the TUI, stored behind {@link Tui}'s
 * `onX` methods and fired from key dispatch (or, for `submit`, from the input
 * box).
 */
export interface TuiHandlers {
  /** The user submitted a message on some pane. */
  submit?: (message: string, paneId: string) => void;
  /** Ctrl+C, in place of the default (stop capture, exit fullscreen, exit). */
  quit?: () => void;
  /** Enter selected a role on a roster pane. */
  selectRole?: (role: RoleOption) => void;
  /** 'r' was pressed on a roster pane. */
  refreshRoster?: () => void;
  /** Ctrl+W closed a tab. Never fires for the company roster, which can't be closed. */
  closeTab?: (paneId: string) => void;
  /** Enter selected a task on a roster pane. */
  selectTask?: (task: TaskChangeSummary) => void;
  /** Enter selected a begun assignment on a task panel. */
  selectAssignment?: (taskId: string, assignment: AssignmentInfo) => void;
  /** 'c' cancelled a task from its task panel. */
  cancelTask?: (taskId: string) => void;
  /** 's' started a `ready` task from its task panel. */
  startTask?: (taskId: string) => void;
  /** 'n' opened the initiate-task form from the company roster. */
  openInitiateTask?: () => void;
  /** The initiate-task form validated and submitted. */
  submitInitiateTask?: (
    paneId: string,
    submission: InitiateTaskSubmission,
  ) => void;
}

/** The redraws a keystroke on a pane can ask the TUI for. */
export interface PaneKeyEffects {
  /** Re-renders the active pane's content, then draws. */
  redrawActivePane(): void;
  /** Draws the document without re-rendering pane content. */
  draw(): void;
}

/**
 * Routes one key-press into the active pane, once {@link Tui} has taken the
 * keys it handles globally (tab switching, quit, Esc, help, close-tab).
 *
 * NB. while a field on the initiate-task form is being typed into, that pane's
 * own raw-key capture owns every remaining key — see
 * {@link dispatchInitiateTaskEdit}, which the caller must try first.
 */
export function dispatchPaneKey(
  pane: Pane | undefined,
  name: string,
  handlers: TuiHandlers,
  effects: PaneKeyEffects,
): void {
  // Up/Down move a flat row highlight the same way on every list-shaped pane
  // (no InlineInput exists on any of these, so the keys are free for
  // navigation) — handled once here rather than re-derived per pane type.
  if (isNavigableList(pane) && (name === 'UP' || name === 'DOWN')) {
    pane.moveSelection(name === 'UP' ? -1 : 1);
    effects.redrawActivePane();
    return;
  }

  if (pane instanceof RosterPane) {
    dispatchRosterKey(pane, name, handlers, effects);
    return;
  }

  if (pane instanceof TaskPane) {
    dispatchTaskKey(pane, name, handlers);
    return;
  }

  if (pane instanceof InitiateTaskPane) {
    dispatchInitiateTaskKey(pane, name, handlers, effects);
    return;
  }

  // On a talkable pane the input holds focus, so the scrollback's native
  // PgUp/PgDn bindings never fire — page the log from here instead. On
  // spectator panes the TextBox is focused and pages itself natively.
  if (
    pane instanceof AssignmentPane &&
    pane.talkable &&
    (name === 'PAGE_UP' || name === 'PAGE_DOWN')
  ) {
    pane.page(name === 'PAGE_UP' ? 1 : -1);
    effects.draw();
  }
}

/**
 * Feeds one key into the initiate-task form's raw text capture, when a field
 * is being edited.
 *
 * Returns whether the key was consumed — while editing, this pane owns every
 * key except Ctrl+C/quit, including ones that would otherwise be global
 * shortcuts (Esc, F1/Ctrl+G, Ctrl+W), so typing "f1" into a prompt doesn't pop
 * up help mid-sentence.
 */
export function dispatchInitiateTaskEdit(
  pane: Pane | undefined,
  name: string,
  effects: PaneKeyEffects,
): boolean {
  if (!(pane instanceof InitiateTaskPane) || !pane.editingField) return false;
  if (name === 'ENTER') {
    pane.commitEdit();
    effects.redrawActivePane();
  } else if (name === 'BACKSPACE') {
    pane.backspace();
    effects.redrawActivePane();
  } else if (name.length === 1) {
    pane.typeChar(name);
    effects.redrawActivePane();
  }
  return true;
}

function dispatchRosterKey(
  pane: RosterPane,
  name: string,
  handlers: TuiHandlers,
  effects: PaneKeyEffects,
): void {
  if (name === 'ENTER') {
    const role = pane.selectedRole;
    if (role) {
      handlers.selectRole?.(role);
      return;
    }
    const task = pane.selectedTask;
    if (task) handlers.selectTask?.(task);
    return;
  }
  if (name === 'r' || name === 'R') {
    handlers.refreshRoster?.();
    return;
  }
  if (name === 'n' || name === 'N') {
    handlers.openInitiateTask?.();
    return;
  }
  // '[' / ']' jump the highlight to the previous/next list (Roles ↔ Tasks) —
  // Tab/Shift+Tab already switch *panes*, so a distinct key is needed for
  // switching *lists* within this one pane; neither bracket is bound anywhere
  // else in this pane or the document.
  if (name === '[' || name === ']') {
    pane.jumpList(name === '[' ? -1 : 1);
    effects.redrawActivePane();
  }
}

function dispatchTaskKey(
  pane: TaskPane,
  name: string,
  handlers: TuiHandlers,
): void {
  if (name === 'ENTER') {
    const assignment = pane.selectedAssignment;
    if (assignment) handlers.selectAssignment?.(pane.id, assignment);
    return;
  }
  if ((name === 'c' || name === 'C') && pane.cancellable) {
    handlers.cancelTask?.(pane.id);
    return;
  }
  if ((name === 's' || name === 'S') && pane.startable) {
    handlers.startTask?.(pane.id);
  }
}

/**
 * The initiate-task pane a dispatched submission is pending on, keyed by
 * pane id.
 *
 * {@link dispatchInitiateTaskKey} holds the live pane reference at the exact
 * moment Enter fires a real submission and records it here; wiring.ts's
 * `onSubmitInitiateTask` handler only ever receives the pane id (not the
 * pane object — see `TuiHandlers.submitInitiateTask`), so this is how it
 * reaches back in to clear `busy` once the async submit settles — see
 * {@link clearInitiateTaskBusy}.
 */
const pendingInitiateTaskSubmits = new Map<string, InitiateTaskPane>();

/**
 * Clears the busy flag a dispatched submission set (see
 * {@link dispatchInitiateTaskKey}) — the caller (wiring.ts's
 * `onSubmitInitiateTask`) must call this once the submit handler's promise
 * settles, on both success (harmless — the pane is about to be replaced by
 * `Tui.replaceWithTaskPane`) and failure (required — the form stays open on
 * failure and must accept another attempt).
 */
export function clearInitiateTaskBusy(paneId: string): void {
  const pane = pendingInitiateTaskSubmits.get(paneId);
  if (pane) pane.busy = false;
  pendingInitiateTaskSubmits.delete(paneId);
}

function dispatchInitiateTaskKey(
  pane: InitiateTaskPane,
  name: string,
  handlers: TuiHandlers,
  effects: PaneKeyEffects,
): void {
  // Reached only when no field is being edited — see dispatchInitiateTaskEdit.
  if (name === 'ENTER') {
    // A submission is already in flight: ignore the repeat press outright,
    // without even re-validating the row — this is what stops a second
    // Enter, pressed before wiring.ts's async submit settles, from firing a
    // second real POST /api/task (see the module-level doc above and
    // InitiateTaskPane.busy).
    if (pane.busy) return;
    const submission = pane.activateRow();
    if (submission) {
      pane.busy = true;
      pendingInitiateTaskSubmits.set(pane.id, pane);
      handlers.submitInitiateTask?.(pane.id, submission);
    }
    effects.redrawActivePane();
    return;
  }
  if (name === 'd' || name === 'D') {
    pane.removeCurrentExpected();
    effects.redrawActivePane();
  }
}
