import { TextBox } from 'terminal-kit';
import { wrapText } from '../tui-format';
import { Pane } from './pane';

/**
 * A pane showing fixed, non-streaming text (e.g. the help screen) — no
 * input, no log, no heading; just the given lines, word-wrapped to the
 * pane's width, with native scrolling if they don't fit.
 */
export class TextPane extends Pane {
  readonly talkable = false;

  constructor(
    id: string,
    label: string,
    textBox: TextBox,
    private readonly lines: string[],
  ) {
    super(id, label, textBox);
  }

  protected render(width: number): string[] {
    return this.lines.flatMap((line) => wrapText(line, width));
  }
}
