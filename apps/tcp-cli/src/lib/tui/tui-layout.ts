// Row budget and geometry for the TUI's fixed layout. Pure arithmetic over a
// terminal size — {@link Tui} owns the widgets, this owns where they go.

/** Rows occupied by the tab bar, at the top of the screen. */
export const TAB_ROWS = 1;

/** Blank row between the tab bar and every pane's content. */
export const TAB_GAP_ROWS = 1;

/** First row of the active pane's content. */
export const CONTENT_TOP = TAB_ROWS + TAB_GAP_ROWS;

/** Rows occupied by the key-hint row, at the bottom of the screen. */
export const HINT_ROWS = 1;

/**
 * Rows reserved for the input box.
 *
 * It starts 1 row high and can grow to this many rows via Alt+Enter before
 * further lines would draw over the hint row.
 */
export const INPUT_ROWS = 3;

/**
 * Narrowest terminal worth laying content out in.
 *
 * Below this a pane's own content (headings, wrapped text, the scrollbar
 * column) has nowhere sane to go, so it is treated the same as "too short":
 * panes stay hidden and unpositioned, and the resize isn't forwarded to
 * terminal-kit's own `Document#onEventSourceResize` (see {@link Tui}'s
 * constructor).
 */
const MIN_CONTENT_WIDTH = 3;

/**
 * Whether the terminal has at least one row for pane content between the tab
 * bar (plus gap) and the hint bar, and is wide enough to lay out at all.
 *
 * NB. {@link CONTENT_TOP} is a fixed offset, not derived from the terminal
 * size, so a terminal shorter than `CONTENT_TOP + HINT_ROWS` would otherwise
 * position (or even just size) a pane's TextBox at or past the hint bar's row.
 * Every pane stays hidden and unpositioned while this is false, rather than
 * risk that.
 */
export function hasRoomForContent(width: number, height: number): boolean {
  return height - CONTENT_TOP - HINT_ROWS >= 1 && width >= MIN_CONTENT_WIDTH;
}

/**
 * Whether the terminal is tall enough to hold the input row above the hint bar
 * without overlapping the content area.
 *
 * False on a very short terminal, in which case the input is dropped entirely
 * (a view-only layout) rather than placed at an invalid or overlapping row.
 * Re-checked on every resize, so the input reappears once the terminal grows
 * back.
 */
export function inputFits(height: number): boolean {
  return height - HINT_ROWS - INPUT_ROWS > CONTENT_TOP;
}

/** The row an input box is placed at, directly above the hint bar. */
export function inputTop(height: number): number {
  return height - HINT_ROWS - INPUT_ROWS;
}

/** Height available to a pane's content, given whether an input box is shown. */
export function contentHeight(height: number, hasInput: boolean): number {
  const inputRows = hasInput ? INPUT_ROWS : 0;
  return Math.max(height - CONTENT_TOP - HINT_ROWS - inputRows, 1);
}
