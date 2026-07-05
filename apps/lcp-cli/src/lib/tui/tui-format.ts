// Pure, stateful formatting of the agent event stream into pane entries for
// the TUI (see tui.ts). Kept separate so the column layout, reasoning
// indent/grey special case, and blank-line separation rules can be
// unit-tested without a live terminal-kit screen.

import { SseEvent } from '../core/sse';
import { RoleOption } from './tui-state';

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
      return wrapText(entry.text, Math.max(width - 2, 1)).map(
        (line) => `  ${line}`,
      );
    }
    const header = `${entry.time} | ${entry.label} | `;
    // Continuation lines wrap at the same reduced width as the header line
    // rather than the full pane width — narrower than strictly necessary, but
    // keeps wrapping a single pass over the text instead of two.
    const wrapped = wrapText(entry.text, Math.max(width - header.length, 1));
    return wrapped.map((line, i) => (i === 0 ? header + line : line));
  }
}

/** Renders a company's role roster for the company pane, marking the highlighted row. */
export function renderRoleList(
  roles: RoleOption[],
  selectedIndex: number,
): string[] {
  if (roles.length === 0) return ['(no roles in this company)'];
  return roles.map(
    (role, i) => `${i === selectedIndex ? '> ' : '  '}${role.name}`,
  );
}
