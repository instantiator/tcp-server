// The one state machine every surface shares. Accumulates audit events and
// stream deltas into a heading/entry list that the TUI re-renders on resize
// (render) and streaming surfaces observe incrementally (onAppend). This
// replaces the per-surface PaneEntryLog / responseSeen / mapAuditHistoryToEvents.

import { AuditWireEvent, StreamDelta } from '@lcp/shared';
import { parseClockTime } from '../core/agent-log-format';
import { renderAuditEvent, TurnState } from './audit-renderers';
import { LogEntry, renderEntry } from './entries';
import {
  HeadingBlockRenderer,
  HeadingInfo,
  HeadingInfoProvider,
  ScopeTracker,
} from './heading';
import { StyleBackend } from './style';

/** An incremental change to the log, delivered to {@link EventLogBuffer.onAppend} listeners. */
export type AppendEvent =
  | { kind: 'heading'; info: HeadingInfo }
  | { kind: 'entry'; entry: LogEntry }
  | { kind: 'delta'; channel: 'reasoning' | 'response'; delta: string };

type Item =
  { type: 'heading'; info: HeadingInfo } | { type: 'entry'; entry: LogEntry };

/** hh:mm:ss from a delta's timestamp, or now. */
function clock(timestamp: string): string {
  return parseClockTime(timestamp) ?? new Date().toTimeString().slice(0, 8);
}

/**
 * Accumulates {@link AuditWireEvent}s and {@link StreamDelta}s into a heading/
 * entry list. History (no deltas) replays `llm_response` text as full blocks;
 * a live turn streams deltas and collapses the trailing `llm_response`/terminal
 * rows to a line (the dedupe rule — {@link TurnState.deltasSeen}, reset by each
 * `llm_request`). One instance per output stream or pane.
 */
export class EventLogBuffer {
  private readonly items: Item[] = [];
  private readonly turn: TurnState = { deltasSeen: false };
  private readonly listeners: ((e: AppendEvent) => void)[] = [];
  private readonly headingRenderer = new HeadingBlockRenderer();
  private readonly scopeTracker = new ScopeTracker();

  constructor(
    private readonly headingInfo: HeadingInfoProvider,
    private readonly hideReasoning = false,
    /** When false, no scope heading blocks are emitted — for single-scope
     * surfaces (a chat/assignment pane) that render their own richer heading. */
    private readonly emitHeadings = true,
  ) {}

  /** Subscribes to incremental appends (used by {@link StreamPresenter}). */
  onAppend(listener: (e: AppendEvent) => void): void {
    this.listeners.push(listener);
  }

  private emit(e: AppendEvent): void {
    for (const listener of this.listeners) listener(e);
  }

  /** Adds one audit event: a heading when the scope changed, then its entries. */
  appendAudit(e: AuditWireEvent): void {
    if (
      this.emitHeadings &&
      this.scopeTracker.changed({
        taskId: e.taskId,
        assignmentId: e.assignmentId,
        agentId: e.agentId,
      })
    ) {
      const info = this.headingInfo({
        taskId: e.taskId,
        assignmentId: e.assignmentId,
        agentId: e.agentId,
      });
      this.items.push({ type: 'heading', info });
      this.emit({ kind: 'heading', info });
    }

    // An llm_request begins a new turn: forget any prior turn's streamed deltas.
    if (e.eventType === 'llm_request') this.turn.deltasSeen = false;

    for (const entry of renderAuditEvent(e, this.turn)) {
      if (this.hideReasoning && entry.style === 'reasoning') continue;
      this.items.push({ type: 'entry', entry });
      this.emit({ kind: 'entry', entry });
    }
  }

  /** Adds one stream delta: extends the trailing same-channel entry, or opens a new one. */
  appendDelta(d: StreamDelta): void {
    if (this.hideReasoning && d.channel === 'reasoning') return;
    this.turn.deltasSeen = true;

    const last = this.items[this.items.length - 1];
    if (last?.type === 'entry' && last.entry.style === d.channel) {
      last.entry.text += d.delta;
      // Extends the open block — streaming surfaces just append the raw token.
      this.emit({ kind: 'delta', channel: d.channel, delta: d.delta });
      return;
    }
    // Opens a new block — emit it as an entry so streaming surfaces get the header.
    const entry: LogEntry = {
      style: d.channel,
      time: clock(d.timestamp),
      label: `llm_response:${d.channel}`,
      text: d.delta,
    };
    this.items.push({ type: 'entry', entry });
    this.emit({ kind: 'entry', entry });
  }

  /** Full re-render for the TUI (re-wraps to `width`). Blank line between items. */
  render(width: number, style: StyleBackend): string[] {
    const lines: string[] = [];
    this.items.forEach((item, i) => {
      if (i > 0) lines.push('');
      if (item.type === 'heading') {
        lines.push(...this.headingRenderer.render(item.info, style));
      } else {
        lines.push(...renderEntry(item.entry, width, style));
      }
    });
    return lines;
  }
}
