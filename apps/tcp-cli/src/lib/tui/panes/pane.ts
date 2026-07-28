// The pane base classes for the TUI (see ../tui.ts, which orchestrates tabs,
// the tab bar/hint row, and the input box across whichever pane is active).
// Each concrete pane — one per sibling module here — owns its own content and
// any post-render scroll behaviour.

import { TextBox } from 'terminal-kit';
import { escapeMarkup, renderMultiListPanel } from '../tui-format';
import { MultiListSelection, SelectableList } from '../tui-state';

/**
 * Common behaviour for every pane: identity, its backing TextBox, and the
 * render/redraw cycle. Subclasses supply `render()`; `afterRedraw()` is the
 * hook for any scroll adjustment that must happen once new content is set
 * (follow-the-tail, scroll-to-selection, or nothing at all).
 */
export abstract class Pane {
  /** Whether this pane shows an input box when active. Only ChatPane overrides this. */
  readonly talkable: boolean = false;
  /** A transient action failure (e.g. a failed refresh/cancel/start), shown
   * until the pane's next successful data update. Only meaningful for panes
   * with no event log of their own — an AssignmentPane's errors go into its
   * log instead (see Tui.appendEvent/showPaneError). */
  errorMessage: string | null = null;

  constructor(
    readonly id: string,
    public label: string,
    readonly textBox: TextBox,
  ) {}

  /** Re-renders this pane's content into its TextBox and applies any scroll adjustment. */
  redraw(): void {
    const width = Math.max(this.textBox.textAreaWidth, 1);
    this.textBox.setContent(this.render(width).join('\n'), true, true);
    this.afterRedraw();
  }

  /** Produces this pane's content lines at the given column width. */
  protected abstract render(width: number): string[];

  /** One red banner line (plus trailing blank) for `errorMessage`, or nothing when unset. */
  protected renderErrorBanner(): string[] {
    return this.errorMessage
      ? [`^R${escapeMarkup(this.errorMessage)}^:`, '']
      : [];
  }

  /** Scroll (or other) adjustment made right after content is set. Default: none. */
  protected afterRedraw(): void {
    // Most panes rely on native/manual scrolling; see ChatPane and RosterPane.
  }

  /** Scrolls this pane's TextBox so content line `line` (0-based) is within its viewport. */
  protected scrollLineIntoView(line: number): void {
    const height = this.textBox.textAreaHeight;
    if (line + this.textBox.scrollY < 0) {
      this.textBox.scrollTo(null, -line, true);
    } else if (line + this.textBox.scrollY > height - 1) {
      this.textBox.scrollTo(null, height - 1 - line, true);
    }
  }
}

/**
 * A pane whose body is a selectable {@link renderMultiListPanel}, kept
 * scrolled to the current selection. Subclasses supply their own heading and
 * populate {@link MultiListPane.lists}.
 *
 * The selected line's offset has to account for however many lines the
 * heading and error banner occupy above the list; keeping that arithmetic
 * here means a new list pane cannot get it subtly wrong.
 */
export abstract class MultiListPane extends Pane {
  protected readonly selection = new MultiListSelection();
  protected lists: SelectableList[] = [];
  private selectedLine = -1;

  /** This pane's heading lines, rendered above the lists. */
  protected abstract renderHeading(width: number): string[];

  protected render(width: number): string[] {
    const heading = this.renderHeading(width);
    const banner = this.renderErrorBanner();
    const { lines, selectedLine } = renderMultiListPanel(
      this.lists,
      this.selection.current,
      width,
    );
    this.selectedLine =
      selectedLine < 0 ? -1 : heading.length + banner.length + selectedLine;
    return [...heading, ...banner, ...lines];
  }

  protected afterRedraw(): void {
    if (this.selectedLine >= 0) this.scrollLineIntoView(this.selectedLine);
  }
}
