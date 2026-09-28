// Pure, stateful formatting of the agent event stream into pane entries for
// the TUI (see tui.ts). Kept separate so the column layout, reasoning
// indent/grey special case, and blank-line separation rules can be
// unit-tested without a live terminal-kit screen.

import type { TaskChangeSummary } from '@tcp/shared';
import { wrapText } from '@tcp/shared';
import {
  ListEntry,
  ListPosition,
  PaneAssignmentInfo,
  RoleOption,
  SelectableList,
} from './tui-state';

// Re-exported for existing callers within this module and its spec — the
// wrap function itself now lives in @tcp/shared's transcript module (no
// terminal-kit dependency) so eavesdrop and render.ts can share it too.
export { wrapText } from '@tcp/shared';

/**
 * Escapes a literal `^` so it survives markup-enabled rendering unchanged.
 * terminal-kit's caret markup (`^K` grey, `^+` bold, `^:` reset, etc. — see
 * tui.ts's colour use) reads any other `^x` as a style code; text that isn't
 * ours to control — model reasoning/response output, role/company names —
 * must be escaped before it reaches a `setContent(text, true)` call, or a
 * stray caret in that text corrupts the colours of everything after it.
 * Applied at render time (not when text is first accumulated) so word-wrap
 * width calculations still operate on true, unescaped character counts.
 */
export function escapeMarkup(text: string): string {
  return text.replace(/\^/g, '^^');
}

/** The `>` marker rendered for a selected row, in inverse video (`^!`/`^:`) — the
 * terminal's own cursor is never drawn/hidden for a plain, non-editable
 * TextBox (see tui.ts's cursor-visibility note), so every selectable list
 * marks its own highlight this way instead. */
export function marker(selected: boolean): string {
  return selected ? '^!>^: ' : '  ';
}

/** Builds one {@link ListEntry} for a role in the company roster's "Roles" list. */
export function makeRoleEntry(role: RoleOption): ListEntry {
  return {
    id: role.id,
    render: (_width: number, selected: boolean) => [
      `${marker(selected)}${escapeMarkup(role.name)}`,
    ],
  };
}

/**
 * Renders the company roster pane's identifying heading: slug + id, a
 * prompt, and a blank separator — everything before the panel's
 * {@link SelectableList}s (Roles, then Tasks).
 */
export function renderRosterHeading(
  companySlug: string,
  companyId: string,
): string[] {
  return [
    `Slug: ${escapeMarkup(companySlug)}`,
    `Id: ${escapeMarkup(companyId)}`,
    '',
    'Please select a role to initiate a chat:',
    '',
  ];
}

/**
 * Renders a panel's {@link SelectableList}s: each list's title, then per
 * group an optional group title, then its entries — blank-line separated
 * between lists. `selectedLine` is the line index (within the returned
 * `lines`) of the current selection, so the caller can scroll it into view
 * without hardcoding this layout a second time; `-1` if there is no
 * selection (e.g. every list is empty).
 */
export function renderMultiListPanel(
  lists: SelectableList[],
  selected: ListPosition | undefined,
  width: number,
): { lines: string[]; selectedLine: number } {
  const lines: string[] = [];
  let selectedLine = -1;
  lists.forEach((list, listIndex) => {
    if (listIndex > 0) lines.push('');
    lines.push(`^+${escapeMarkup(list.title)}^:`);
    list.groups.forEach((group, groupIndex) => {
      if (group.title) lines.push(escapeMarkup(group.title));
      if (group.entries.length === 0 && group.title) {
        lines.push('  (none)');
      }
      group.entries.forEach((entry, entryIndex) => {
        const isSelected = Boolean(
          selected &&
          selected.listIndex === listIndex &&
          selected.groupIndex === groupIndex &&
          selected.entryIndex === entryIndex,
        );
        if (isSelected) selectedLine = lines.length;
        lines.push(...entry.render(width, isSelected));
      });
    });
  });
  return { lines, selectedLine };
}

/** `yyyy-MM-dd HH:mm:ss` for a task-list entry's timestamp column. */
export function dateTimeSeconds(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** Truncates `text` to `width` columns, replacing the last character with an ellipsis if it doesn't fit. */
export function truncateWithEllipsis(text: string, width: number): string {
  const w = Math.max(width, 1);
  if (text.length <= w) return text;
  return w === 1 ? text.slice(0, 1) : text.slice(0, w - 1) + '…';
}

/** The task-list state/completion indicator, e.g. `in progress: 2/3`, `succeeded`. */
export function formatTaskState(summary: TaskChangeSummary): string {
  return summary.status === 'in-progress'
    ? `in progress: ${summary.completedSteps}/${summary.totalSteps}`
    : summary.status;
}

/**
 * Renders one company task-list entry: a single truncated line when not
 * highlighted (`yyyy-MM-dd HH:mm:ss [shortcode] (state) "request"`), or —
 * highlighted — the prompt expanded and word-wrapped up to `maxLines`, with
 * a blank line of spacing before and after.
 */
export function renderTaskListEntry(
  summary: TaskChangeSummary,
  selected: boolean,
  width: number,
  maxLines: number,
): string[] {
  const w = Math.max(width, 1);
  const mark = marker(selected);
  const meta = `${dateTimeSeconds(summary.createdAt)} [${summary.shortcode}] (${formatTaskState(summary)})`;
  const body = `${meta} "${summary.request}"`;

  if (!selected) {
    return [
      `${mark}${escapeMarkup(truncateWithEllipsis(body, w - mark.length))}`,
    ];
  }

  const wrapped = wrapText(body, Math.max(w - mark.length, 1)).slice(
    0,
    Math.max(maxLines, 1),
  );
  return [
    '',
    ...wrapped.map((line, i) =>
      i === 0 ? `${mark}${escapeMarkup(line)}` : `  ${escapeMarkup(line)}`,
    ),
    '',
  ];
}

/** Builds one {@link ListEntry} for a task in the company roster's "Tasks" list. */
export function makeTaskEntry(
  summary: TaskChangeSummary,
  maxLines: number,
): ListEntry {
  return {
    id: summary.id,
    render: (width: number, selected: boolean) =>
      renderTaskListEntry(summary, selected, width, maxLines),
  };
}

/** Left-hand label column width shared by every line of {@link renderAssignmentPaneHeading} (`'Role name (and slug):'`, the longest). */
const ASSIGNMENT_HEADING_LABEL_WIDTH = 21;

/** One field line of {@link renderAssignmentPaneHeading}, label padded to its column. */
function headingField(label: string, value: string): string {
  return `${label.padEnd(ASSIGNMENT_HEADING_LABEL_WIDTH)} ${value}`;
}

/**
 * Renders the identifying heading shown at the top of every assignment
 * (agent chat) pane: the agent id, the role's name and slug, and — when
 * known — the backing assignment's id/shortcode/status (coloured via
 * {@link statusColor}) and prompt (word-wrapped, continuation lines indented
 * under the opening quote). `roleSlug`/`assignment` are absent for a
 * consultation-follower pane (not fetched — see `ChatSession.streamAgent`);
 * those fields render as `'—'` instead.
 */
export function renderAssignmentPaneHeading(
  agentId: string,
  roleName: string,
  roleSlug: string | undefined,
  assignment: PaneAssignmentInfo | undefined,
  width: number,
): string[] {
  const roleLine = roleSlug
    ? `${escapeMarkup(roleName)} (${escapeMarkup(roleSlug)})`
    : escapeMarkup(roleName);
  const statusLine = assignment
    ? `${statusColor(assignment.status)}${escapeMarkup(assignment.status)}^:${
        assignment.status === 'failed' && assignment.failureReason
          ? ` (${escapeMarkup(assignment.failureReason)})`
          : ''
      }`
    : '—';
  const promptPrefix = headingField('Prompt:', '');
  const wrapped = wrapText(
    assignment?.prompt ?? '—',
    Math.max(width - promptPrefix.length, 1),
  );
  const promptLines = wrapped.map((line, i) =>
    i === 0
      ? `${promptPrefix}"${escapeMarkup(line)}`
      : `${' '.repeat(promptPrefix.length)}${escapeMarkup(line)}`,
  );
  promptLines[promptLines.length - 1] += '"';
  return [
    headingField('Agent id:', escapeMarkup(agentId)),
    headingField('Role name (and slug):', roleLine),
    headingField('Assignment id:', escapeMarkup(assignment?.id ?? '—')),
    headingField(
      'Assignment shortcode:',
      escapeMarkup(assignment?.shortcode ?? '—'),
    ),
    headingField('Assignment status:', statusLine),
    ...promptLines,
    '',
  ];
}

/**
 * Grey/cyan/green/red/yellow markup colour code for a task or assignment
 * status — shared so the task panel's assignment list and (if it adopts the
 * same convention later) the company task list's state indicator agree on
 * one mapping instead of two.
 */
export function statusColor(status: string): string {
  switch (status) {
    case 'ready':
      return '^K'; // waiting — grey
    case 'succeeded':
      return '^G';
    case 'failed':
      return '^R';
    case 'cancelled':
      return '^Y';
    default:
      // planning / in-progress / in-qa / finalising and anything else active
      return '^C';
  }
}

/** One row of the task panel's Assignments list. */
export interface AssignmentRow {
  id: string;
  /**
   * This assignment's index in the task's plan — 0 for the planning
   * assignment, an implement step's 1-based position, or (for qa) the step
   * it reviews — retained even when the row is rendered out of plan order
   * (e.g. grouped Incomplete/Complete). Falls back to array position when
   * the assignment has no plan index (`AssignmentInfo.planIndex` null).
   */
  index: number;
  role: string;
  /** The assignment's mode (`plan`/`implement`/`qa`/`finalise` etc.), shown before the status as `(mode: status)`. */
  mode: string;
  status: string;
  prompt: string;
  /** The assignment's working agent, once dispatched — null before it begins. */
  agentId: string | null;
  /** The working agent's own live status — see {@link AssignmentInfo.agentStatus}. */
  agentStatus?: string | null;
  /** Why the assignment failed — set only when `status` is `failed`. */
  failureReason: string | null;
}

/**
 * True for a non-chat agent that's `idle` on an `in-progress` assignment —
 * decision 4 of the 002.02 plan: on a task agent, `idle` means only
 * "created, not started yet" (a queued worker slot, not a stall). Mirrors
 * the web client's `isWaitingToStart` (`FE/visualisation/isometric/company/
 * rules/companySnapshot.ts`) without importing frontend code.
 */
function isWaitingToStart(
  agentStatus: string,
  mode: string,
  assignmentStatus: string,
): boolean {
  return (
    agentStatus === 'idle' &&
    mode !== 'chat' &&
    assignmentStatus === 'in-progress'
  );
}

/**
 * The live-status label appended to a task-panel assignment row: "no agent
 * yet" before one is dispatched, "waiting to start" for decision 4's queued
 * case, the agent's own status otherwise, or '' when nothing useful is known
 * yet (an agent is dispatched but its status hasn't been seeded/seen live).
 */
export function formatAgentStatusLabel(
  row: Pick<AssignmentRow, 'agentId' | 'agentStatus' | 'mode' | 'status'>,
): string {
  if (!row.agentId) return 'no agent yet';
  if (!row.agentStatus) return '';
  if (isWaitingToStart(row.agentStatus, row.mode, row.status)) {
    return 'waiting to start';
  }
  return row.agentStatus;
}

/**
 * Renders one task-panel assignment row: `n. <role> (<mode>: <status>)
 * [agent: <live agent status>] "<prompt>"` (the agent segment omitted when
 * {@link formatAgentStatusLabel} has nothing to show), truncated with an
 * ellipsis when not highlighted; word-wrapped up to `maxLines` (with
 * spacing) when highlighted — mirroring {@link renderTaskListEntry}'s
 * truncate/expand behaviour. The status word is colourised via
 * {@link statusColor} without perturbing the width budget (the budget is
 * computed from the plain, uncoloured meta text).
 */
export function renderAssignmentListEntry(
  row: AssignmentRow,
  selected: boolean,
  width: number,
  maxLines: number,
): string[] {
  const w = Math.max(width, 1);
  const mark = marker(selected);
  const reasonSuffix =
    row.status === 'failed' && row.failureReason
      ? ` — ${row.failureReason}`
      : '';
  const agentLabel = formatAgentStatusLabel(row);
  const agentSuffix = agentLabel ? ` [agent: ${agentLabel}]` : '';
  const plainMeta = `${row.index}. ${row.role} (${row.mode}: ${row.status}${reasonSuffix})${agentSuffix}`;
  const colouredMeta = `${row.index}. ${escapeMarkup(row.role)} (${escapeMarkup(row.mode)}: ${statusColor(row.status)}${escapeMarkup(row.status)}^:${escapeMarkup(reasonSuffix)})${escapeMarkup(agentSuffix)}`;
  // Budget for the prompt text: total width minus the marker, the (plain,
  // uncoloured) meta, a separating space, and the two quote characters.
  const promptBudget = Math.max(w - mark.length - plainMeta.length - 3, 0);

  if (!selected) {
    const promptText = truncateWithEllipsis(row.prompt, promptBudget);
    return [`${mark}${colouredMeta} "${escapeMarkup(promptText)}"`];
  }

  const wrapped = wrapText(row.prompt, Math.max(promptBudget, 1)).slice(
    0,
    Math.max(maxLines, 1),
  );
  const lines = wrapped.map((line, i) =>
    i === 0
      ? `${mark}${colouredMeta} "${escapeMarkup(line)}`
      : `  ${escapeMarkup(line)}`,
  );
  lines[lines.length - 1] += '"';
  return ['', ...lines, ''];
}

/** Builds one {@link ListEntry} for an assignment in the task panel's Assignments list. */
export function makeAssignmentEntry(
  row: AssignmentRow,
  maxLines: number,
): ListEntry {
  return {
    id: row.id,
    // Only assignments that have begun are selectable — an unstarted
    // ('ready') assignment has no conversation to open.
    selectable: row.status !== 'ready',
    render: (width: number, selected: boolean) =>
      renderAssignmentListEntry(row, selected, width, maxLines),
  };
}

/** Left-hand label column width for {@link renderTaskPaneHeading} (`'Task id:'`/`'Status:'`/`'Prompt:'` padded to one past the longest). */
const TASK_HEADING_LABEL_WIDTH = 9;

/**
 * Renders the task panel's identifying heading: `Task id:`/`Status:`
 * (coloured via {@link statusColor})/`Prompt:` (the prompt word-wrapped,
 * continuation lines indented under the opening quote), then a blank line
 * and the "Assignments" section label — everything before the panel's
 * Assignments {@link SelectableList}.
 */
export function renderTaskPaneHeading(
  taskId: string,
  status: string,
  prompt: string,
  width: number,
): string[] {
  const idLine = `${'Task id:'.padEnd(TASK_HEADING_LABEL_WIDTH)} ${escapeMarkup(taskId)}`;
  const statusLine = `${'Status:'.padEnd(TASK_HEADING_LABEL_WIDTH)} ${statusColor(status)}${escapeMarkup(status)}^:`;
  const promptPrefix = `${'Prompt:'.padEnd(TASK_HEADING_LABEL_WIDTH)} `;
  const wrapped = wrapText(prompt, Math.max(width - promptPrefix.length, 1));
  const promptLines = wrapped.map((line, i) =>
    i === 0
      ? `${promptPrefix}"${escapeMarkup(line)}`
      : `${' '.repeat(promptPrefix.length)}${escapeMarkup(line)}`,
  );
  promptLines[promptLines.length - 1] += '"';
  return [idLine, statusLine, ...promptLines, ''];
}
