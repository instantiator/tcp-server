// Full-screen multi-agent TUI: one tab per monitored agent, independent
// scrollback per tab, and an input box shown only for talkable (chat) panes.
// Built directly on terminal-kit's Document/TextBox/InlineInput widgets (see
// terminal-kit-document.d.ts) plus the pure PaneManager/PaneEntryLog helpers
// that carry the tab and formatting logic.
//
// One pane is special: the company roster (added via addRosterPane), listing
// the company's roles with an up/down-moved highlight. It has no InlineInput,
// so arrow keys and Enter are free for list navigation and "initiate chat"
// (see handleKey's roster branch) instead of being routed to a text box.
//
// Layout, top to bottom:
//   row 0                        — tab bar
//   rows 1..                     — the active pane's scrollback (TextBox)
//   3 rows (talkable panes only) — input box ('> ' prompt; Alt+Enter grows it)
//   last row                     — key hints
//
// Testability: the constructor accepts a `term` (size + key/resize event
// source) and an `outputDst` draw-target override, so specs can drive the
// REAL widgets off-screen — synthetic 'key' events in, a ScreenBuffer
// character dump out. No fake widget classes: faking terminal-kit's widget
// API is exactly how the original, never-rendering implementation slipped
// past its tests.

import {
  Document,
  InlineInput,
  TextBox,
  terminal as sharedTerminal,
} from 'terminal-kit';
import { Renderer } from '../core/render';
import { SseEvent } from '../core/sse';
import { PaneEntryLog, renderRoleList } from './tui-format';
import { PaneManager, PaneSpec, RoleOption } from './tui-state';

export type { RoleOption } from './tui-state';

/** Result of interpreting one raw key-press at the terminal level. */
export type KeyAction = 'next-pane' | 'prev-pane' | 'quit' | 'none';

/**
 * Pure keybinding decision for the keys handled globally. Everything else is
 * routed by the Document to the focused widget: the input box on a talkable
 * pane (arrows/Home/End edit, Enter submits, Alt+Enter inserts a newline),
 * or the scrollback TextBox on a spectator pane (arrows/PgUp/PgDn/Home/End
 * scroll natively). Tab/Shift+Tab are safe to take for pane switching: the
 * focused InlineInput binds Tab to auto-complete, a no-op with no completer
 * configured, and TextBox doesn't bind Tab at all.
 */
export function interpretKey(name: string): KeyAction {
  if (name === 'TAB') return 'next-pane';
  if (name === 'SHIFT_TAB') return 'prev-pane';
  if (name === 'CTRL_C') return 'quit';
  return 'none';
}

/**
 * The structural slice of terminal-kit's Terminal that {@link Tui} drives —
 * also what the spec's fake implements (an EventEmitter with a size).
 */
export interface TuiTerminal {
  width: number;
  height: number;
  fullscreen(on: boolean): void;
  grabInput(on: boolean | Record<string, unknown>): void;
  processExit(code: number): void;
  on(event: string, handler: (...args: unknown[]) => void): unknown;
}

export interface TuiOptions {
  term?: TuiTerminal;
  /** Where the Document draws; defaults to `term`. Specs pass a ScreenBuffer. */
  outputDst?: unknown;
  hideReasoning?: boolean;
}

interface Pane {
  spec: PaneSpec;
  textBox: TextBox;
  /** Absent for the roster pane, which renders its role list instead. */
  log?: PaneEntryLog;
  /** Present only for the company roster pane. */
  roster?: { roles: RoleOption[]; selectedIndex: number };
  /** Auto-scroll to the newest entry; cleared when the user scrolls up. */
  follow: boolean;
  /** Whether this pane's agent has a turn in flight. */
  busy: boolean;
  /** Mid-typed input, preserved across switches away and back. */
  draft: string;
}

const TAB_ROWS = 1;
const HINT_ROWS = 1;
/** Rows reserved for the input box — it starts at 1 high and can grow to
 * this many rows via Alt+Enter before further lines draw over the hint row. */
const INPUT_ROWS = 3;

/**
 * Orchestrates the full-screen multi-pane view: one scrollback TextBox per
 * agent (or a role roster for the company pane), a tab bar, a key-hint row,
 * and an {@link InlineInput} shown only when the active pane is talkable.
 */
export class Tui {
  private readonly term: TuiTerminal;
  private readonly hideReasoning: boolean;
  private readonly document: Document;
  private readonly manager = new PaneManager();
  private readonly panes = new Map<string, Pane>();
  private readonly tabBar: TextBox;
  private readonly hintBar: TextBox;
  private input: InlineInput | null = null;
  /** Which pane's draft the current `input` widget holds, if any. */
  private inputPaneId: string | null = null;
  private submitHandler: ((message: string, paneId: string) => void) | null =
    null;
  private quitHandler: (() => void) | null = null;
  private selectRoleHandler: ((role: RoleOption) => void) | null = null;
  private refreshRosterHandler: (() => void) | null = null;

  constructor(opts: TuiOptions = {}) {
    this.term = opts.term ?? sharedTerminal;
    this.hideReasoning = opts.hideReasoning ?? false;
    this.term.fullscreen(true);
    this.document = new Document({
      outputDst: opts.outputDst ?? this.term,
      eventSource: this.term,
    });
    // The Document's own Tab binding cycles focus across every element (tab
    // bar and hidden panes included) — disable it; Tab is a pane switch here.
    this.document.keyBindings = {};
    this.tabBar = new TextBox({
      parent: this.document,
      x: 0,
      y: 0,
      width: this.term.width,
      height: TAB_ROWS,
    });
    this.hintBar = new TextBox({
      parent: this.document,
      x: 0,
      y: this.term.height - HINT_ROWS,
      width: this.term.width,
      height: HINT_ROWS,
    });
    this.term.on('key', (name) => this.handleKey(name as string));
    this.term.on('resize', () => {
      // The input must be rebuilt, not repositioned: InlineInput places its
      // prompt TextBox at construction coordinates only, so a later
      // setSizeAndPosition would move the editable area but leave the '> '
      // prompt behind. refresh() recreates it at the new position.
      this.dropInput();
      this.refresh();
    });
  }

  /** Registers the callback fired when the user submits a message on some pane. */
  onSubmit(handler: (message: string, paneId: string) => void): void {
    this.submitHandler = handler;
  }

  /**
   * Registers the callback fired on Ctrl+C, in place of the default
   * (stop capture, exit fullscreen, exit the process). Callers with their own
   * two-stage quit semantics (e.g. abort an in-flight turn first, only exit
   * the process on a second Ctrl+C while idle) should call {@link stop}
   * themselves when they actually intend to exit.
   */
  onQuit(handler: () => void): void {
    this.quitHandler = handler;
  }

  /** Registers the callback fired when Enter selects a role on a roster pane. */
  onSelectRole(handler: (role: RoleOption) => void): void {
    this.selectRoleHandler = handler;
  }

  /** Registers the callback fired when 'r' is pressed on a roster pane. */
  onRefreshRoster(handler: () => void): void {
    this.refreshRosterHandler = handler;
  }

  /** Adds a new tab for an agent (talkable = the user can address it directly). */
  addPane(spec: PaneSpec): void {
    if (this.panes.has(spec.id)) return;
    this.manager.addPane(spec);
    const textBox = new TextBox({
      parent: this.document,
      x: 0,
      y: TAB_ROWS,
      width: this.term.width,
      height: 1,
      scrollable: true,
      vScrollBar: true,
      hidden: true,
    });
    const pane: Pane = {
      spec,
      textBox,
      log: new PaneEntryLog(this.hideReasoning),
      follow: true,
      busy: false,
      draft: '',
    };
    // Wheel/scrollbar/native-key scrolls land here: keep following the tail
    // only while the user is actually at the bottom.
    textBox.on('scroll', () => {
      pane.follow = this.atBottom(textBox);
    });
    this.panes.set(spec.id, pane);
    this.refresh();
  }

  /**
   * Adds the company roster pane: a spectate-only (no InlineInput) tab
   * listing the company's roles, navigated with Up/Down and Enter (see
   * handleKey). Only one roster pane is expected per session.
   */
  addRosterPane(spec: {
    id: string;
    label: string;
    roles: RoleOption[];
  }): void {
    if (this.panes.has(spec.id)) return;
    const paneSpec: PaneSpec = {
      id: spec.id,
      label: spec.label,
      talkable: false,
    };
    this.manager.addPane(paneSpec);
    const textBox = new TextBox({
      parent: this.document,
      x: 0,
      y: TAB_ROWS,
      width: this.term.width,
      height: 1,
      hidden: true,
    });
    const pane: Pane = {
      spec: paneSpec,
      textBox,
      roster: { roles: spec.roles, selectedIndex: 0 },
      follow: true,
      busy: false,
      draft: '',
    };
    this.panes.set(spec.id, pane);
    this.refresh();
  }

  /** Replaces a roster pane's role list (e.g. the 'r' refresh key). */
  updateRosterRoles(paneId: string, roles: RoleOption[]): void {
    const pane = this.panes.get(paneId);
    if (!pane?.roster) return;
    pane.roster.roles = roles;
    pane.roster.selectedIndex = Math.min(
      pane.roster.selectedIndex,
      Math.max(roles.length - 1, 0),
    );
    if (this.manager.activePane?.id === paneId) this.redrawActivePane();
  }

  /** Removes a pane (e.g. a consultation follower whose agent finished). */
  removePane(id: string): void {
    const pane = this.panes.get(id);
    if (pane) {
      if (this.inputPaneId === id) {
        this.input?.destroy();
        this.input = null;
        this.inputPaneId = null;
      }
      pane.textBox.destroy(false, true);
      this.panes.delete(id);
    }
    this.manager.removePane(id);
    this.refresh();
  }

  /** Switches the active tab programmatically (e.g. after initiating a chat). */
  switchToPane(id: string): void {
    this.manager.switchTo(id);
    this.refresh();
  }

  /** Appends one SSE event to the named pane and redraws it if active. */
  appendEvent(paneId: string, event: SseEvent): void {
    const pane = this.panes.get(paneId);
    if (!pane?.log) return;
    pane.log.append(event);
    if (this.manager.activePane?.id === paneId) this.redrawActivePane();
  }

  /**
   * Marks one pane's turn as in flight: its input keeps accepting typed text
   * (the user can compose the next message) but Enter won't submit until the
   * turn ends, and — while this pane is active — the hint row says why.
   */
  setBusy(paneId: string, busy: boolean): void {
    const pane = this.panes.get(paneId);
    if (!pane) return;
    pane.busy = busy;
    if (this.manager.activePane?.id === paneId) {
      if (this.input) this.input.disabled = busy;
      this.renderChrome();
      this.document.draw();
    }
  }

  /** Tears down fullscreen/input capture, restoring the normal terminal. */
  stop(): void {
    this.input?.destroy();
    this.input = null;
    this.inputPaneId = null;
    this.term.grabInput(false);
    this.term.fullscreen(false);
  }

  private handleKey(name: string): void {
    const action = interpretKey(name);
    if (action === 'next-pane') {
      this.manager.next();
      this.refresh();
      return;
    }
    if (action === 'prev-pane') {
      this.manager.prev();
      this.refresh();
      return;
    }
    if (action === 'quit') {
      if (this.quitHandler) {
        this.quitHandler();
      } else {
        this.stop();
        this.term.processExit(0);
      }
      return;
    }

    const activePane = this.activePaneWidgets();
    if (activePane?.roster) {
      // No InlineInput exists on a roster pane, so these keys are free for
      // list navigation/selection instead of text editing or native scroll.
      if (name === 'UP') {
        this.moveRosterSelection(activePane, -1);
        return;
      }
      if (name === 'DOWN') {
        this.moveRosterSelection(activePane, 1);
        return;
      }
      if (name === 'ENTER') {
        const role = activePane.roster.roles[activePane.roster.selectedIndex];
        if (role) this.selectRoleHandler?.(role);
        return;
      }
      if (name === 'r' || name === 'R') {
        this.refreshRosterHandler?.();
        return;
      }
      return;
    }

    // On a talkable pane the input holds focus, so the scrollback's native
    // PgUp/PgDn bindings never fire — page the log from here instead. On
    // spectator panes the TextBox is focused and pages itself natively.
    if (this.input && (name === 'PAGE_UP' || name === 'PAGE_DOWN')) {
      this.pageActivePane(name === 'PAGE_UP' ? 1 : -1);
    }
  }

  private moveRosterSelection(pane: Pane, delta: number): void {
    const roster = pane.roster;
    if (!roster || roster.roles.length === 0) return;
    const n = roster.roles.length;
    roster.selectedIndex = (roster.selectedIndex + delta + n) % n;
    this.redrawActivePane();
  }

  /** Scrolls the active pane by a page; +1 = towards older content. */
  private pageActivePane(direction: 1 | -1): void {
    const pane = this.activePaneWidgets();
    if (!pane) return;
    const step = Math.max(pane.textBox.textAreaHeight - 1, 1);
    pane.textBox.scroll(0, direction * step, true);
    pane.follow = this.atBottom(pane.textBox);
    this.document.draw();
  }

  /** Whether the box is scrolled to its very bottom (scrollY is ≤ 0). */
  private atBottom(textBox: TextBox): boolean {
    return (
      textBox.scrollY <=
      textBox.textAreaHeight - textBox.getContentSize().height
    );
  }

  private activePaneWidgets(): Pane | undefined {
    const active = this.manager.activePane;
    return active ? this.panes.get(active.id) : undefined;
  }

  /** Re-derives the whole screen for the current pane/tab/input state. */
  private refresh(): void {
    this.updateInput();
    this.layout();
    const activeId = this.manager.activePane?.id;
    for (const [id, pane] of this.panes) {
      if (id === activeId) pane.textBox.show(true);
      else pane.textBox.hide(true);
    }
    this.renderChrome();
    this.focus();
    this.redrawActivePane();
  }

  /** Positions every widget for the current terminal size and input presence. */
  private layout(): void {
    const { width, height } = this.term;
    const inputRows = this.input ? INPUT_ROWS : 0;
    const logHeight = Math.max(height - TAB_ROWS - HINT_ROWS - inputRows, 1);
    this.tabBar.setSizeAndPosition({ x: 0, y: 0, width, height: TAB_ROWS });
    this.hintBar.setSizeAndPosition({
      x: 0,
      y: height - HINT_ROWS,
      width,
      height: HINT_ROWS,
    });
    for (const pane of this.panes.values()) {
      pane.textBox.setSizeAndPosition({
        x: 0,
        y: TAB_ROWS,
        width,
        height: logHeight,
      });
    }
  }

  /** Renders the tab bar and the key-hint row (content only; no draw). */
  private renderChrome(): void {
    const active = this.manager.activePane;
    const label = (p: PaneSpec) =>
      p.id === active?.id ? `[ ${p.label} ]` : `  ${p.label}  `;
    this.tabBar.setContent(
      this.manager.panesInOrder.map(label).join('|'),
      false,
      true,
    );
    const activePane = this.activePaneWidgets();
    const hints = [
      ...(this.input
        ? activePane?.busy
          ? ['waiting for response…']
          : ['Enter send', 'Alt+Enter newline']
        : activePane?.roster
          ? ['Up/Down select', 'Enter chat', 'r refresh']
          : []),
      'Tab switch',
      'PgUp/PgDn scroll',
      'Ctrl+C quit',
    ];
    this.hintBar.setContent(hints.join(' · '), false, true);
  }

  /** Focuses the input when present, else the active scrollback (native scroll keys). */
  private focus(): void {
    const target = this.input ?? this.activePaneWidgets()?.textBox;
    if (target) this.document.giveFocusTo(target);
  }

  /** Renders the active pane's content into its TextBox and draws the document. */
  private redrawActivePane(): void {
    const pane = this.activePaneWidgets();
    if (pane) {
      const width = Math.max(pane.textBox.textAreaWidth, 1);
      const lines = pane.roster
        ? renderRoleList(pane.roster.roles, pane.roster.selectedIndex)
        : (pane.log?.render(width) ?? []);
      pane.textBox.setContent(lines.join('\n'), false, true);
      if (pane.follow) pane.textBox.scrollToBottom(true);
    }
    this.document.draw();
  }

  /** Stashes the outgoing pane's draft and destroys the input (recreated by updateInput). */
  private dropInput(): void {
    if (!this.input) return;
    if (this.inputPaneId) {
      const prevPane = this.panes.get(this.inputPaneId);
      if (prevPane) prevPane.draft = this.input.getValue();
    }
    this.input.destroy();
    this.input = null;
    this.inputPaneId = null;
  }

  /**
   * Creates or destroys the input box when the active pane's talkability (or
   * identity, with multiple talkable panes) changes. Each pane's draft and
   * busy state survive round-trips through other panes.
   */
  private updateInput(): void {
    const active = this.manager.activePane;
    const shouldShow = this.manager.inputEnabled;
    if (!shouldShow) {
      this.dropInput();
      return;
    }
    if (this.input && this.inputPaneId === active?.id) return;
    this.dropInput();
    const pane = this.panes.get(active!.id)!;
    this.input = new InlineInput({
      parent: this.document,
      x: 0,
      // Constructed at its final position: InlineInput's '> ' prompt is a
      // separate TextBox placed at construction coordinates only, so this
      // element cannot be repositioned later (see the resize handler).
      y: this.term.height - HINT_ROWS - INPUT_ROWS,
      width: this.term.width,
      value: pane.draft,
      prompt: { content: '> ' },
    });
    this.inputPaneId = pane.spec.id;
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
      this.redrawActivePane();
      if (message) this.submitHandler?.(message, pane.spec.id);
    });
  }
}

/**
 * Adapts a {@link Tui} pane to the {@link Renderer} interface `chat.ts`'s
 * existing `streamAgent`/`runTurn` control flow already drives — this is what
 * lets that flow stay unchanged between TUI and piped-output modes; only
 * which `Renderer` gets constructed differs.
 */
export function tuiRenderer(tui: Tui, paneId: string): Renderer {
  let responseSeen = false;
  return {
    render(event: SseEvent): void {
      if (event.kind === 'response') responseSeen = true;
      tui.appendEvent(paneId, event);
    },
    get responseSeen() {
      return responseSeen;
    },
    finish(): void {
      // Panes have no open-block state to flush; SSE-driven redraws already
      // reflect the latest content.
    },
  };
}
