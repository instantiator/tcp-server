import { TextBox } from 'terminal-kit';
import { escapeMarkup, marker, wrapText } from '../tui-format';
import { RoleOption } from '../tui-state';
import { Pane } from './pane';

/** One row of the initiate-task form, in display order. */
type InitiateTaskRow =
  | { kind: 'prompt' }
  | { kind: 'role'; roleId: string; name: string }
  | { kind: 'expected'; filename: string }
  | { kind: 'add-expected' }
  | { kind: 'start-toggle' }
  | { kind: 'submit' };

/** The task-create request built by {@link InitiateTaskPane.activateRow} on a valid submit. */
export interface InitiateTaskSubmission {
  companyId: string;
  request: string;
  plannerRoleId: string;
  expected: string[];
  startImmediately: boolean;
}

/**
 * The initiate-task form: a fixed field list (prompt, planner role, add/
 * remove expected-output filenames, a start-immediately toggle, submit) — no
 * general form framework, just this panel's own rows. Never talkable;
 * text entry for the two free-text rows (prompt, a new expected filename) is
 * this panel's own minimal raw-key capture (see `Tui.handleKey`), not
 * terminal-kit's `InlineInput` (which only ever attaches to a *talkable*
 * pane, and — being single-purpose for "send a chat message" — has no notion
 * of "which of several fields is being typed into").
 *
 * ponytail: the text fields are append/backspace only, no interior cursor
 * movement — a real per-field cursor is the upgrade path if that's ever
 * needed; for a prompt and a filename, appending is enough.
 */
export class InitiateTaskPane extends Pane {
  readonly talkable = false;
  private selectedRow = 0;
  private prompt = '';
  private selectedRoleId: string | undefined;
  private expected: string[] = [];
  private startImmediately = false;
  private validationMessage: string | null = null;
  /** Which field is being raw-captured, if any; the draft text lives in `draft`. */
  editingField: 'prompt' | 'expected' | null = null;
  private draft = '';

  constructor(
    id: string,
    label: string,
    textBox: TextBox,
    readonly companyId: string,
    private roles: RoleOption[],
    defaultRoleId: string | undefined,
  ) {
    super(id, label, textBox);
    this.selectedRoleId = defaultRoleId;
  }

  private rows(): InitiateTaskRow[] {
    return [
      { kind: 'prompt' },
      ...this.roles.map((r): InitiateTaskRow => ({
        kind: 'role',
        roleId: r.id,
        name: r.name,
      })),
      ...this.expected.map((filename): InitiateTaskRow => ({
        kind: 'expected',
        filename,
      })),
      { kind: 'add-expected' },
      { kind: 'start-toggle' },
      { kind: 'submit' },
    ];
  }

  /** Row count without building the row array — prompt/add-expected/start-toggle/submit are always present. */
  private rowCount(): number {
    return 4 + this.roles.length + this.expected.length;
  }

  /** Moves the row highlight by `delta`, cycling top↔bottom. Ignored while editing a field. */
  moveSelection(delta: number): void {
    if (this.editingField) return;
    const count = this.rowCount();
    this.selectedRow = (this.selectedRow + delta + count) % count;
  }

  /** The row currently highlighted (for Enter/'d' to act on). */
  private currentRow(): InitiateTaskRow {
    return this.rows()[this.selectedRow];
  }

  /**
   * Enter on the highlighted row: starts editing the prompt or a new
   * expected filename, toggles a role/the start-immediately checkbox, or
   * validates and fires `onSubmit` (returning its result: `null` on
   * validation failure, the built request otherwise — {@link Tui} does the
   * actual API call and pane hand-off).
   */
  activateRow(): InitiateTaskSubmission | null | undefined {
    const row = this.currentRow();
    if (row.kind === 'prompt') {
      this.editingField = 'prompt';
      this.draft = this.prompt;
      return undefined;
    }
    if (row.kind === 'add-expected') {
      this.editingField = 'expected';
      this.draft = '';
      return undefined;
    }
    if (row.kind === 'role') {
      this.selectedRoleId = row.roleId;
      return undefined;
    }
    if (row.kind === 'start-toggle') {
      this.startImmediately = !this.startImmediately;
      return undefined;
    }
    // 'submit'
    if (!this.prompt.trim()) {
      this.validationMessage = 'Enter a prompt before submitting.';
      return null;
    }
    if (!this.selectedRoleId) {
      this.validationMessage = 'Select a planner role before submitting.';
      return null;
    }
    this.validationMessage = null;
    return {
      companyId: this.companyId,
      request: this.prompt.trim(),
      plannerRoleId: this.selectedRoleId,
      expected: [...this.expected],
      startImmediately: this.startImmediately,
    };
  }

  /** Removes the highlighted expected-output row ('d'), a no-op on any other row. */
  removeCurrentExpected(): void {
    const row = this.currentRow();
    if (row.kind !== 'expected') return;
    this.expected = this.expected.filter((f) => f !== row.filename);
    this.selectedRow = Math.min(this.selectedRow, this.rowCount() - 1);
  }

  /** Appends one character to the field being edited. No-op unless editing. */
  typeChar(ch: string): void {
    if (this.editingField) this.draft += ch;
  }

  /** Removes the last character of the field being edited. No-op unless editing. */
  backspace(): void {
    if (this.editingField) this.draft = this.draft.slice(0, -1);
  }

  /** Commits the field being edited (Enter while editing). No-op unless editing. */
  commitEdit(): void {
    if (this.editingField === 'prompt') {
      this.prompt = this.draft;
    } else if (this.editingField === 'expected') {
      const filename = this.draft.trim();
      if (filename) this.expected.push(filename);
    }
    this.editingField = null;
    this.draft = '';
  }

  protected render(width: number): string[] {
    const rows = this.rows();
    const lines: string[] = ['Initiate task', '', ...this.renderErrorBanner()];
    rows.forEach((row, i) => {
      const mark = marker(i === this.selectedRow);
      lines.push(`${mark}${this.renderRow(row, i === this.selectedRow)}`);
    });
    if (this.validationMessage) {
      lines.push('', `^R${escapeMarkup(this.validationMessage)}^:`);
    }
    return lines.flatMap((line) => wrapText(line, width));
  }

  private renderRow(row: InitiateTaskRow, selected: boolean): string {
    switch (row.kind) {
      case 'prompt': {
        const text =
          selected && this.editingField === 'prompt'
            ? `${this.draft}_`
            : this.prompt || '(empty — Enter to type)';
        return `Prompt: "${escapeMarkup(text)}"`;
      }
      case 'role': {
        const chosen = row.roleId === this.selectedRoleId ? '(*)' : '( )';
        return `${chosen} ${escapeMarkup(row.name)}`;
      }
      case 'expected':
        return `- ${escapeMarkup(row.filename)} (d to remove)`;
      case 'add-expected': {
        const text =
          selected && this.editingField === 'expected' ? `${this.draft}_` : '';
        return text
          ? `+ Add expected output: "${escapeMarkup(text)}"`
          : '+ Add expected output';
      }
      case 'start-toggle':
        return `[${this.startImmediately ? 'x' : ' '}] Start immediately`;
      case 'submit':
        return 'Submit';
    }
  }
}
