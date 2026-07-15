// Full-screen multi-agent TUI: one tab per monitored agent, independent
// scrollback per tab, and an input box shown only for talkable (chat) panes.
// Built directly on terminal-kit's Document/TextBox/InlineInput widgets (see
// terminal-kit-document.d.ts). The pane content/rendering logic itself lives
// in panes.ts (Pane/ChatPane/RosterPane/TextPane) — this file owns tabs, the
// hint row, the input box, and key routing across whichever pane is active.
//
// One pane is special: the company roster (added via addRosterPane), listing
// the company's roles with an up/down-moved highlight. It has no InlineInput,
// so arrow keys and Enter are free for list navigation and "initiate chat"
// (see handleKey's roster branch) instead of being routed to a text box.
//
// Another is the help pane (TextPane, opened with F1 or Ctrl+G — the latter
// since F1 is frequently intercepted before it reaches the terminal, e.g.
// bound to brightness on Mac laptops): fixed text, no input, and
// self-closing — Tab/Shift+Tab/Esc away from it removes it rather than just
// switching away, so it never lingers as a normal tab (see handleKey's
// closeIfSelfClosing).
//
// Layout, top to bottom:
//   row 0                        — tab bar
//   row 1                        — blank (TAB_GAP_ROWS)
//   rows 2..                     — the active pane's scrollback (TextBox),
//                                   itself opening with a "Name/Id" (or, on
//                                   the roster, "Slug/Id" + prompt) heading
//   3 rows (talkable panes only) — input box ('> ' prompt; Alt+Enter grows it)
//   last row                     — key hints
//
// Testability: the constructor accepts a `term` (size + key/resize event
// source) and an `outputDst` draw-target override, so specs can drive the
// REAL widgets off-screen — synthetic 'key' events in, a ScreenBuffer
// character dump out. No fake widget classes: faking terminal-kit's widget
// API is exactly how the original, never-rendering implementation slipped
// past its tests.
//
// Colour: pane/roster content and the tab bar render with terminal-kit's
// caret markup enabled (grey reasoning blocks, a bold/bright active tab, an
// inverted '>' marking the roster's highlighted role). Any text we didn't
// author ourselves — reasoning/response deltas, role and company names — is
// escaped via tui-format's escapeMarkup() first, or a literal '^' in that
// text would be misread as a markup code.
//
// Cursor: terminal-kit only ever hides/positions the real terminal cursor
// via a focused *editable* widget's own drawSelfCursor (EditableTextBox);
// plain TextBoxes (the roster, spectator panes) have none, so the cursor
// last drawn by the InlineInput would otherwise linger, stale, wherever it
// was when focus moved away. draw() re-derives cursor visibility on every
// redraw instead of trusting terminal-kit's default (hidden unless the
// active pane has an *enabled* InlineInput).
//
// Ctrl+W closes the active tab (any pane except the roster, which is
// permanent); see handleKey and onCloseTab.

import {
  Document,
  InlineInput,
  TextBox,
  terminal as sharedTerminal,
} from 'terminal-kit';
import { Renderer } from '../core/render';
import { SseEvent } from '../core/sse';
import { escapeMarkup } from './tui-format';
import { ChatPane, Pane, RosterPane, TextPane } from './panes';
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
  /** Shows/hides the terminal's own blinking cursor (see Tui's cursor-visibility note above). */
  hideCursor(hidden: boolean): void;
}

export interface TuiOptions {
  term?: TuiTerminal;
  /** Where the Document draws; defaults to `term`. Specs pass a ScreenBuffer. */
  outputDst?: unknown;
  hideReasoning?: boolean;
}

const TAB_ROWS = 1;
/** Blank row between the tab bar and every pane's content. */
const TAB_GAP_ROWS = 1;
const CONTENT_TOP = TAB_ROWS + TAB_GAP_ROWS;
const HINT_ROWS = 1;
/** Rows reserved for the input box — it starts at 1 high and can grow to
 * this many rows via Alt+Enter before further lines draw over the hint row. */
const INPUT_ROWS = 3;

/** Fixed id for the (at most one) help pane; see Tui.showHelp(). */
const HELP_PANE_ID = '__help__';

const HELP_TEXT = [
  'Keyboard shortcuts',
  '',
  'Tab / Shift+Tab   Switch tabs',
  'Ctrl+W            Close the active tab (not the company roster)',
  'Ctrl+C            Stop watching (mid-turn), or quit (idle)',
  'F1 / Ctrl+G       Show this help; Tab, Shift+Tab, or Esc closes it',
  '                  (Ctrl+G works even where F1 is intercepted by the',
  '                  OS or terminal — e.g. bound to brightness on Macs)',
  '',
  'On the company roster:',
  '  Up / Down       Move the highlight',
  '  Enter           Start a chat with the highlighted role',
  '  r               Refresh the role list',
  '',
  'On a talkable tab:',
  '  Enter           Send the message',
  '  Alt+Enter       Insert a newline',
  '  PgUp / PgDn     Scroll the scrollback',
  "  'exit' / 'quit' Type either to end the whole session",
];

/**
 * Joins `hints` (most- to least-important) with ' · ', dropping trailing
 * ones that would overflow `width` — a narrow terminal loses the least
 * important hints first rather than silently truncating mid-word (a
 * non-wrapping single-row TextBox would otherwise just clip the tail,
 * which could as easily cut off "Ctrl+C quit" as anything else).
 */
function fitHints(hints: string[], width: number): string {
  let result = '';
  for (const hint of hints) {
    const candidate = result ? `${result} · ${hint}` : hint;
    if (candidate.length > width) break;
    result = candidate;
  }
  return result;
}

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
  private closeTabHandler: ((paneId: string) => void) | null = null;

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

  /**
   * Registers the callback fired when Ctrl+W closes a tab (the tab is
   * already removed from the TUI by the time this fires — see handleKey).
   * Never fires for the company roster pane, which can't be closed.
   */
  onCloseTab(handler: (paneId: string) => void): void {
    this.closeTabHandler = handler;
  }

  /** Adds a new tab for an agent (talkable = the user can address it directly). */
  addPane(spec: PaneSpec): void {
    if (this.panes.has(spec.id)) return;
    this.manager.addPane(spec);
    const textBox = this.createContentTextBox();
    const pane = new ChatPane(
      spec.id,
      spec.label,
      textBox,
      spec.talkable,
      spec.roleId,
      this.hideReasoning,
    );
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
    slug: string;
    roles: RoleOption[];
  }): void {
    if (this.panes.has(spec.id)) return;
    const paneSpec: PaneSpec = {
      id: spec.id,
      label: spec.label,
      talkable: false,
    };
    this.manager.addPane(paneSpec);
    const textBox = this.createContentTextBox();
    const pane = new RosterPane(
      spec.id,
      spec.label,
      textBox,
      spec.slug,
      spec.roles,
    );
    this.panes.set(spec.id, pane);
    this.refresh();
  }

  /**
   * Shows the help pane (F1 or Ctrl+G), creating it on first use and just
   * switching to it thereafter. It self-closes when the user tabs (or Esc's)
   * away — see handleKey's closeIfSelfClosing — so re-opening always starts
   * fresh.
   */
  private showHelp(): void {
    if (!this.panes.has(HELP_PANE_ID)) {
      const paneSpec: PaneSpec = {
        id: HELP_PANE_ID,
        label: 'Help',
        talkable: false,
      };
      this.manager.addPane(paneSpec);
      const textBox = this.createContentTextBox();
      this.panes.set(
        HELP_PANE_ID,
        new TextPane(HELP_PANE_ID, 'Help', textBox, HELP_TEXT),
      );
    }
    this.switchToPane(HELP_PANE_ID);
  }

  /** Replaces a roster pane's role list (e.g. the 'r' refresh key). */
  updateRosterRoles(paneId: string, roles: RoleOption[]): void {
    const pane = this.panes.get(paneId);
    if (!(pane instanceof RosterPane)) return;
    pane.setRoles(roles);
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
    if (!(pane instanceof ChatPane)) return;
    pane.appendEvent(event);
    if (this.manager.activePane?.id === paneId) this.redrawActivePane();
  }

  /**
   * Marks one pane's turn as in flight: its input keeps accepting typed text
   * (the user can compose the next message) but Enter won't submit until the
   * turn ends, and — while this pane is active — the hint row says why.
   */
  setBusy(paneId: string, busy: boolean): void {
    const pane = this.panes.get(paneId);
    if (!(pane instanceof ChatPane)) return;
    pane.busy = busy;
    if (this.manager.activePane?.id === paneId) {
      if (this.input) this.input.disabled = busy;
      this.renderChrome();
      this.draw();
    }
  }

  /** Tears down fullscreen/input capture, restoring the normal terminal. */
  stop(): void {
    this.input?.destroy();
    this.input = null;
    this.inputPaneId = null;
    this.term.grabInput(false);
    this.term.fullscreen(false);
    // Always leave the cursor visible on exit — terminal-kit's own cleanup
    // only does this on the default Ctrl+C→processExit path, not when a
    // caller supplies its own onQuit handler and calls stop() directly.
    this.term.hideCursor(false);
  }

  private handleKey(name: string): void {
    const action = interpretKey(name);
    if (action === 'next-pane' || action === 'prev-pane') {
      if (!this.closeIfSelfClosing()) {
        if (action === 'next-pane') this.manager.next();
        else this.manager.prev();
        this.refresh();
      }
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

    // Esc is the other way to dismiss a self-closing pane (Tab/Shift+Tab —
    // handled above — being the primary one). No-op on every other pane.
    if (name === 'ESCAPE') {
      this.closeIfSelfClosing();
      return;
    }

    // Ctrl+G is a second way in: F1 is frequently intercepted before it ever
    // reaches the terminal (e.g. bound to brightness on Mac laptops unless
    // Fn is held), so help shouldn't depend on F1 alone getting through.
    if (name === 'F1' || name === 'CTRL_G') {
      this.showHelp();
      return;
    }

    const activePane = this.activePaneWidgets();

    // Ctrl+W closes any tab except the company roster, which is the
    // permanent anchor — closing the last agent tab just leaves you back
    // on the roster, the same state --company-id-only starts in.
    if (name === 'CTRL_W') {
      if (activePane && !(activePane instanceof RosterPane)) {
        const paneId = activePane.id;
        this.removePane(paneId);
        this.closeTabHandler?.(paneId);
      }
      return;
    }

    if (activePane instanceof RosterPane) {
      // No InlineInput exists on a roster pane, so these keys are free for
      // list navigation/selection instead of text editing or native scroll.
      if (name === 'UP') {
        activePane.moveSelection(-1);
        this.redrawActivePane();
        return;
      }
      if (name === 'DOWN') {
        activePane.moveSelection(1);
        this.redrawActivePane();
        return;
      }
      if (name === 'ENTER') {
        const role = activePane.selectedRole;
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
    if (
      activePane instanceof ChatPane &&
      activePane.talkable &&
      (name === 'PAGE_UP' || name === 'PAGE_DOWN')
    ) {
      activePane.page(name === 'PAGE_UP' ? 1 : -1);
      this.draw();
    }
  }

  /**
   * Closes the active pane if it's one that self-closes on blur (currently:
   * the help pane only) — used for Tab/Shift+Tab/Esc. `removePane`'s own
   * "closest remaining neighbour" reassignment is the "sensible tab" the
   * user lands on afterwards. Returns whether it closed anything.
   */
  private closeIfSelfClosing(): boolean {
    const active = this.activePaneWidgets();
    if (active instanceof TextPane) {
      this.removePane(active.id);
      return true;
    }
    return false;
  }

  /** A scrollable, initially-hidden content TextBox at the pane content area — shared by addPane/addRosterPane/showHelp. */
  private createContentTextBox(): TextBox {
    return new TextBox({
      parent: this.document,
      x: 0,
      y: CONTENT_TOP,
      width: this.term.width,
      height: 1,
      scrollable: true,
      vScrollBar: true,
      hidden: true,
    });
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
    const logHeight = Math.max(height - CONTENT_TOP - HINT_ROWS - inputRows, 1);
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
        y: CONTENT_TOP,
        width,
        height: logHeight,
      });
    }
  }

  /** Renders the tab bar and the key-hint row (content only; no draw). */
  private renderChrome(): void {
    const active = this.manager.activePane;
    // Bold bright cyan (^+^C) for the active tab, dim (^-) for the rest;
    // labels are escaped since they're role/company names, not our own text.
    const label = (p: PaneSpec) => {
      const text = escapeMarkup(p.label);
      return p.id === active?.id ? `^+^C[ ${text} ]^:` : `^-  ${text}  ^:`;
    };
    this.tabBar.setContent(
      this.manager.panesInOrder.map(label).join('|'),
      true,
      true,
    );
    const activePane = this.activePaneWidgets();
    const isRoster = activePane instanceof RosterPane;
    const isHelp = activePane instanceof TextPane;
    const busy = activePane instanceof ChatPane && activePane.busy;
    const closable = activePane !== undefined && !isRoster;
    // The help hint is only worth showing when help isn't already open.
    const helpHint = isHelp ? [] : ['F1/Ctrl+G help'];
    // Most- to least-important — fitHints drops from the end first, so a
    // narrow terminal loses "PgUp/PgDn scroll"/"F1/Ctrl+G help" before it
    // ever loses "Ctrl+C quit" or the pane's primary action.
    const hints = this.input
      ? [
          busy ? 'waiting for response…' : 'Enter send',
          'Ctrl+C quit',
          ...(closable ? ['Ctrl+W close'] : []),
          ...(busy ? [] : ['Alt+Enter newline']),
          'Tab switch',
          'PgUp/PgDn scroll',
          ...helpHint,
        ]
      : isRoster
        ? [
            'Enter chat',
            'Ctrl+C quit',
            'Up/Down select',
            'r refresh',
            'Tab switch',
            'PgUp/PgDn scroll',
            ...helpHint,
          ]
        : [
            'Ctrl+C quit',
            ...(closable ? ['Ctrl+W close'] : []),
            ...(isHelp ? ['Esc close'] : []),
            'Tab switch',
            'PgUp/PgDn scroll',
            ...helpHint,
          ];
    this.hintBar.setContent(fitHints(hints, this.term.width), false, true);
  }

  /** Focuses the input when present, else the active scrollback (native scroll keys). */
  private focus(): void {
    const target = this.input ?? this.activePaneWidgets()?.textBox;
    if (target) this.document.giveFocusTo(target);
  }

  /** Re-renders the active pane's content and draws the document. */
  private redrawActivePane(): void {
    this.activePaneWidgets()?.redraw();
    this.draw();
  }

  /** Draws the document, then re-derives the real cursor's visibility — see
   * the module comment: terminal-kit doesn't hide it for plain (non-editable)
   * TextBoxes, so a stale blinking cursor from the input box would otherwise
   * linger on any pane/state that doesn't accept typed input. */
  private draw(): void {
    this.document.draw();
    this.term.hideCursor(!this.input || this.input.disabled);
  }

  /** Stashes the outgoing pane's draft and destroys the input (recreated by updateInput). */
  private dropInput(): void {
    if (!this.input) return;
    if (this.inputPaneId) {
      const prevPane = this.panes.get(this.inputPaneId);
      if (prevPane instanceof ChatPane) prevPane.draft = this.input.getValue();
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
    const pane = this.panes.get(active!.id);
    if (!(pane instanceof ChatPane)) return; // inputEnabled implies a talkable ChatPane
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
    this.inputPaneId = pane.id;
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
      if (message) this.submitHandler?.(message, pane.id);
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
    renderUserPrompt(): void {
      // TUI user-prompt echo lands in the pane log another way (010.3.3);
      // this adapter has nothing to do for it yet.
    },
  };
}
