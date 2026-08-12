// The chat input box's lifecycle: creating it for whichever talkable pane is
// active, preserving that pane's draft across switches, and destroying it
// again. Only shown on a talkable pane, and only when the terminal is tall
// enough to hold it (see tui-layout's inputFits).

import { Document, InlineInput } from 'terminal-kit';
import { AssignmentPane } from './panes/assignment-pane';
import { INPUT_ROWS } from './tui-layout';

/**
 * Owns the at-most-one {@link InlineInput} widget.
 *
 * NB. the widget is rebuilt rather than moved whenever its pane or position
 * changes: an InlineInput places its `'> '` prompt TextBox at construction
 * coordinates only, so repositioning it later would move the editable area and
 * leave the prompt behind.
 */
export class InputBox {
  private input: InlineInput | null = null;
  /** The pane whose draft this input holds. */
  private owner: AssignmentPane | null = null;

  /**
   * @param document the Document every widget is parented to.
   * @param onSubmit fired after the widget has been cleared, with the trimmed
   * message — empty when the user submitted nothing but a redraw is still due.
   */
  constructor(
    private readonly document: Document,
    private readonly onSubmit: (message: string, paneId: string) => void,
  ) {}

  /** The live widget, for focus handling. Null when no input is shown. */
  get element(): InlineInput | null {
    return this.input;
  }

  /** Whether an input box is currently shown. */
  get present(): boolean {
    return this.input !== null;
  }

  /** Whether the input is showing but refusing to submit (a turn is in flight). */
  get disabled(): boolean {
    return this.input?.disabled ?? false;
  }

  set disabled(value: boolean) {
    if (this.input) this.input.disabled = value;
  }

  /** Whether the current input belongs to the pane with this id. */
  isFor(paneId: string): boolean {
    return this.owner?.id === paneId;
  }

  /** Stashes the outgoing pane's draft and destroys the widget. */
  drop(): void {
    if (!this.input) return;
    if (this.owner) this.owner.draft = this.input.getValue();
    this.input.destroy();
    this.input = null;
    this.owner = null;
  }

  /**
   * Shows an input box for `pane` at row `y`, rebuilding it if it currently
   * belongs to another pane or another position. A no-op if it is already
   * exactly that.
   */
  ensureFor(pane: AssignmentPane, y: number, width: number): void {
    if (this.input && this.owner === pane) return;
    this.drop();
    this.owner = pane;
    this.input = new InlineInput({
      parent: this.document,
      x: 0,
      y,
      width,
      value: pane.draft,
      prompt: { content: '> ' },
    });
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
      this.onSubmit(message, pane.id);
    });
  }

  /**
   * Focuses the input when a left-click lands anywhere in the rows reserved
   * for it, not just the one row it currently occupies. Returns whether focus
   * moved.
   *
   * terminal-kit only focuses an element that is itself under the pointer,
   * which leaves two dead zones a user reasonably expects to be live: the
   * `'> '` prompt (a plain TextBox child, and `TextBox.onClick` only takes
   * focus when scrollable) and the {@link INPUT_ROWS} growth rows below a
   * single-line input, which contain no element at all until Alt+Enter grows
   * into them. Both look like part of the input box on screen.
   *
   * NB. the Document's own handler runs first (registered in its constructor),
   * so a click that already did the right thing — landing on the editable
   * area, which focuses and positions the cursor — is left alone.
   */
  focusOnClickIn(row: number): boolean {
    const input = this.input;
    if (!input || input.disabled || input.hasFocus) return false;
    const top = input.outputY;
    if (row < top || row >= top + INPUT_ROWS) return false;
    this.document.giveFocusTo(input);
    return true;
  }
}
