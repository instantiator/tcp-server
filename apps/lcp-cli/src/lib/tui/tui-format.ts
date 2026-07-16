// Pure, stateful formatting of the agent event stream into pane entries for
// the TUI (see tui.ts). Kept separate so the column layout, reasoning
// indent/grey special case, and blank-line separation rules can be
// unit-tested without a live terminal-kit screen.

import type { TaskChangeSummary } from '@lcp/shared';
import { SseEvent } from '../core/sse';
import {
  ListEntry,
  ListPosition,
  RoleOption,
  SelectableList,
} from './tui-state';

/** Reads a string field from an event's data payload, defaulting to ''. */
function str(data: Record<string, unknown> | undefined, key: string): string {
  const value = data?.[key];
  return typeof value === 'string' ? value : '';
}

/** hh:mm:ss from an event's timestamp, or from now if absent/invalid. */
function clockTime(timestamp: string | undefined): string {
  const date = timestamp ? new Date(timestamp) : new Date();
  const valid = !Number.isNaN(date.getTime()) ? date : new Date();
  return valid.toTimeString().slice(0, 8);
}

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

/**
 * Greedy word-wrap: splits on existing newlines (kept as hard breaks, with
 * trailing ones stripped), then packs words onto lines up to `width`.
 */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(width, 1);
  const paragraphs = text.replace(/\n+$/, '').split('\n');
  const lines: string[] = [];
  for (const para of paragraphs) {
    const words = para.split(/[ \t]+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length > w && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
  }
  return lines.length > 0 ? lines : [''];
}

/** One logical block of pane content — a discrete event or a streamed delta. */
export interface PaneEntry {
  style: 'discrete' | 'reasoning' | 'response';
  time: string;
  /** Event kind/label shown in the middle column; unused for 'reasoning'. */
  label?: string;
  /** Raw, unwrapped accumulated text. */
  text: string;
}

/**
 * Accumulates {@link SseEvent}s into {@link PaneEntry} blocks for one pane and
 * renders them to fixed-width display lines on demand. Consecutive deltas of
 * the same kind (reasoning or response) extend the same entry; anything else
 * starts a new one — this is what makes rendering insert a blank line only
 * between entries, never within one, matching the discrete/reasoning/response
 * blank-line rules by construction.
 */
export class PaneEntryLog {
  private entries: PaneEntry[] = [];

  constructor(private readonly hideReasoning: boolean) {}

  /** Appends one event, creating or extending an entry as appropriate. */
  append(event: SseEvent): void {
    const time = clockTime(event.timestamp);
    const data = event.data;
    switch (event.kind) {
      case 'agent_status': {
        const status = str(data, 'status');
        const reason = str(data, 'reason');
        const text = reason ? `${status} (${reason})` : status;
        this.pushDiscrete(time, 'agent_status', text);
        break;
      }
      case 'consultation_started': {
        const roleName = str(data, 'roleName');
        this.pushDiscrete(
          time,
          'consultation_started',
          `consulting ${roleName}`,
        );
        break;
      }
      case 'llm': {
        const activity = str(data, 'activity');
        const tool = str(data, 'tool');
        const text = tool ? `${activity}: ${tool}` : activity;
        this.pushDiscrete(time, 'llm', text);
        break;
      }
      case 'compaction_started':
      case 'compaction_complete': {
        this.pushDiscrete(time, event.kind, this.formatCompaction(event));
        break;
      }
      case 'reasoning': {
        if (this.hideReasoning) break;
        this.appendDelta('reasoning', time, undefined, str(data, 'delta'));
        break;
      }
      case 'response': {
        this.appendDelta('response', time, 'response', str(data, 'delta'));
        break;
      }
      default:
        // Terminal kinds (completed/failed) and unknown kinds are handled by
        // the caller (e.g. tearing down the pane), not rendered as an entry.
        break;
    }
  }

  private formatCompaction(event: SseEvent): string {
    const d = event.data ?? {};
    const num = (v: unknown) => (typeof v === 'number' ? v : '?');
    if (event.kind === 'compaction_started') {
      const strats = Array.isArray(d.strategies)
        ? (d.strategies as string[]).join(', ')
        : '';
      return `compacting: strategies=[${strats}], ${num(d.tokensBefore)}/${num(d.windowSize)} tokens (${num(d.pct)}%)`;
    }
    return `compacted: ${num(d.tokensAfter)}/${num(d.windowSize)} tokens (${num(d.pctAfter)}%)`;
  }

  private pushDiscrete(time: string, label: string, text: string): void {
    this.entries.push({ style: 'discrete', time, label, text });
  }

  private appendDelta(
    style: 'reasoning' | 'response',
    time: string,
    label: string | undefined,
    delta: string,
  ): void {
    const last = this.entries[this.entries.length - 1];
    if (last && last.style === style) {
      last.text += delta;
      return;
    }
    this.entries.push({ style, time, label, text: delta });
  }

  /** Renders all entries to display lines at the given column width. */
  render(width: number): string[] {
    const lines: string[] = [];
    this.entries.forEach((entry, i) => {
      if (i > 0) lines.push('');
      lines.push(...this.renderEntry(entry, width));
    });
    return lines;
  }

  private renderEntry(entry: PaneEntry, width: number): string[] {
    if (entry.style === 'reasoning') {
      // Grey (^K), reset (^:) per line — independent per line rather than
      // one span across the whole block, so colour can't leak past a line
      // that gets dropped or reordered.
      return wrapText(entry.text, Math.max(width - 2, 1)).map(
        (line) => `^K  ${escapeMarkup(line)}^:`,
      );
    }
    const header = `${entry.time} | ${entry.label} | `;
    // Continuation lines wrap at the same reduced width as the header line
    // rather than the full pane width — narrower than strictly necessary, but
    // keeps wrapping a single pass over the text instead of two.
    const wrapped = wrapText(entry.text, Math.max(width - header.length, 1));
    return wrapped.map((line, i) =>
      i === 0 ? header + escapeMarkup(line) : escapeMarkup(line),
    );
  }
}

/** The `>` marker rendered for a selected row, in inverse video (`^!`/`^:`) — the
 * terminal's own cursor is never drawn/hidden for a plain, non-editable
 * TextBox (see tui.ts's cursor-visibility note), so every selectable list
 * marks its own highlight this way instead. */
function marker(selected: boolean): string {
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
 * highlighted (`yyyy-MM-dd HH:mm:ss (state) "request"`), or — highlighted —
 * the prompt expanded and word-wrapped up to `maxLines`, with a blank line
 * of spacing before and after.
 */
export function renderTaskListEntry(
  summary: TaskChangeSummary,
  selected: boolean,
  width: number,
  maxLines: number,
): string[] {
  const w = Math.max(width, 1);
  const mark = marker(selected);
  const meta = `${dateTimeSeconds(summary.createdAt)} (${formatTaskState(summary)})`;
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

/** Renders the identifying heading shown at the top of every chat pane. */
export function renderPaneHeading(name: string, id: string): string[] {
  return [`Name: ${escapeMarkup(name)}`, `Id: ${escapeMarkup(id)}`, ''];
}
