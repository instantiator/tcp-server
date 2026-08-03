// The key-hint row's content: which shortcuts the active pane advertises, and
// how many of them fit the terminal's width.

import { AssignmentPane } from './panes/assignment-pane';
import { InitiateTaskPane } from './panes/initiate-task-pane';
import { Pane } from './panes/pane';
import { RosterPane } from './panes/roster-pane';
import { TaskPane } from './panes/task-pane';
import { TextPane } from './panes/text-pane';

/**
 * Joins `hints` (most- to least-important) with ' · ', dropping trailing ones
 * that would overflow `width`.
 *
 * A narrow terminal loses the least important hints first rather than silently
 * truncating mid-word — a non-wrapping single-row TextBox would otherwise just
 * clip the tail, which could as easily cut off "Ctrl+C quit" as anything else.
 */
export function fitHints(hints: string[], width: number): string {
  let result = '';
  for (const hint of hints) {
    const candidate = result ? `${result} · ${hint}` : hint;
    if (candidate.length > width) break;
    result = candidate;
  }
  return result;
}

/**
 * The hints the active pane advertises, most- to least-important.
 *
 * {@link fitHints} drops from the end first, so a narrow terminal loses
 * "PgUp/PgDn scroll" and "F1/Ctrl+G help" before it ever loses "Ctrl+C quit"
 * or the pane's primary action.
 */
export function paneHints(pane: Pane | undefined, hasInput: boolean): string[] {
  const isRoster = pane instanceof RosterPane;
  const isHelp = pane instanceof TextPane;
  const busy = pane instanceof AssignmentPane && pane.busy;
  const closable = pane !== undefined && !isRoster;
  // The help hint is only worth showing when help isn't already open.
  const helpHint = isHelp ? [] : ['F1/Ctrl+G help'];

  if (hasInput) {
    return [
      busy ? 'waiting for response…' : 'Enter send',
      'Ctrl+C quit',
      ...(closable ? ['Ctrl+W close'] : []),
      ...(busy ? [] : ['Alt+Enter newline']),
      'Tab switch',
      'PgUp/PgDn scroll',
      ...helpHint,
    ];
  }
  if (isRoster) {
    return [
      'Enter chat',
      'Ctrl+C quit',
      'Up/Down select',
      'r refresh',
      'n new task',
      'Tab switch',
      'PgUp/PgDn scroll',
      '[/] switch list',
      ...helpHint,
    ];
  }
  if (pane instanceof TaskPane) {
    return [
      'Enter open',
      'Ctrl+C quit',
      ...(pane.cancellable ? ['c cancel'] : []),
      ...(pane.startable ? ['s start'] : []),
      'Up/Down select',
      ...(closable ? ['Ctrl+W close'] : []),
      'Tab switch',
      ...helpHint,
    ];
  }
  if (pane instanceof InitiateTaskPane) {
    const editing = pane.editingField !== null;
    return [
      editing ? 'Enter commit' : 'Enter edit/select/submit',
      'Ctrl+C quit',
      ...(editing ? [] : ['Up/Down select', 'd remove']),
      ...(closable ? ['Ctrl+W close'] : []),
      'Tab switch',
      ...helpHint,
    ];
  }
  return [
    'Ctrl+C quit',
    ...(closable ? ['Ctrl+W close'] : []),
    ...(isHelp ? ['Esc close'] : []),
    'Tab switch',
    'PgUp/PgDn scroll',
    ...helpHint,
  ];
}
