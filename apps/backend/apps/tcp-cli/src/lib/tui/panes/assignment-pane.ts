import type { WireEvent } from '@tcp/shared';
import { EventLogBuffer } from '@tcp/shared';
import { TextBox } from 'terminal-kit';
import { markupStyle } from '../../render/style';
import { renderAssignmentPaneHeading } from '../tui-format';
import { PaneAssignmentInfo } from '../tui-state';
import { Pane } from './pane';

/**
 * A monitored agent's tab: its event log (rendered under the agent/role/
 * assignment identifying heading — see {@link renderAssignmentPaneHeading}),
 * auto-scrolling to the newest entry unless the user has scrolled up to read
 * back through it. Named for its *backing assignment* (every agent works
 * exactly one — see `TcpAssignment`), not the chat UI, since that's what a
 * task's plan actually schedules and what the heading/tab now key off.
 */
export class AssignmentPane extends Pane {
  readonly talkable: boolean;
  /** The role's slug, for the heading's "Role name (and slug)" line.
   * Undefined for consultation-follower panes (the SSE event that creates
   * them carries a role name but no role id/slug). */
  private readonly roleSlug: string | undefined;
  /** This pane's backing assignment. Undefined for a consultation-follower
   * pane (not fetched — see `ChatSession.streamAgent`); heading fields that
   * need it render as `'—'` instead. */
  private readonly assignment: PaneAssignmentInfo | undefined;
  /** Single-scope, so no scope heading blocks — the pane renders its own richer heading. */
  private readonly buffer: EventLogBuffer;
  /** Auto-scroll to the newest entry; cleared when the user scrolls up. */
  private follow = true;
  /** Whether this pane's agent has a turn in flight. */
  busy = false;
  /** Mid-typed input, preserved across switches away and back. */
  draft = '';

  constructor(
    id: string,
    label: string,
    textBox: TextBox,
    talkable: boolean,
    roleSlug: string | undefined,
    assignment: PaneAssignmentInfo | undefined,
    hideReasoning: boolean,
  ) {
    super(id, label, textBox);
    this.talkable = talkable;
    this.roleSlug = roleSlug;
    this.assignment = assignment;
    this.buffer = new EventLogBuffer(() => ({}), hideReasoning, false);
    // Wheel/scrollbar/native-key scrolls land here: keep following the tail
    // only while the user is actually at the bottom.
    textBox.on('scroll', () => {
      this.follow = this.atBottom();
    });
  }

  /** This pane's assignment shortcode, if known — used by Tui's tab label. */
  get assignmentShortcode(): string | null | undefined {
    return this.assignment?.shortcode;
  }

  /** Appends one wire event (audit row or stream delta) to this pane's buffer. */
  appendEvent(event: WireEvent): void {
    if (event.type === 'stream') this.buffer.appendDelta(event);
    else this.buffer.appendAudit(event.event);
  }

  /**
   * Scrolls by a page; +1 = towards older content. Only relevant when this
   * pane's own TextBox isn't focused — on a talkable pane the InlineInput
   * holds focus instead, so PgUp/PgDn never reach the TextBox's native
   * scroll bindings; Tui.handleKey calls this directly in that case.
   */
  page(direction: 1 | -1): void {
    const step = Math.max(this.textBox.textAreaHeight - 1, 1);
    this.textBox.scroll(0, direction * step, true);
    this.follow = this.atBottom();
  }

  protected render(width: number): string[] {
    const heading = renderAssignmentPaneHeading(
      this.id,
      this.label,
      this.roleSlug,
      this.assignment,
      width,
    );
    return [...heading, ...this.buffer.render(width, markupStyle)];
  }

  protected afterRedraw(): void {
    if (this.follow) this.textBox.scrollToBottom(true);
  }

  /** Whether the box is scrolled to its very bottom (scrollY is ≤ 0). */
  private atBottom(): boolean {
    return (
      this.textBox.scrollY <=
      this.textBox.textAreaHeight - this.textBox.getContentSize().height
    );
  }
}
