// Full-screen multi-agent TUI: one tab per monitored agent, independent
// scrollback per tab, and an input box shown only for the talkable (root)
// agent. Built on terminal-kit's Document/Container/TextBox/InlineInput
// widgets (see terminal-kit-document.d.ts for why these need a local ambient
// declaration) plus the pure PaneManager/PaneEntryLog helpers, which carry
// the actual pane/tab and formatting logic so it's testable without a live
// terminal.

import {
  Container,
  Document,
  InlineInput,
  TextBox,
  terminal as sharedTerminal,
  Terminal,
} from 'terminal-kit';
import { Renderer } from './render';
import { SseEvent } from './sse';
import { PaneEntryLog } from './tui-format';
import { PaneManager, PaneSpec } from './tui-state';

/** Result of interpreting one raw key-press against the current focus state. */
export type KeyAction = 'next-pane' | 'prev-pane' | 'quit' | 'none';

/**
 * Pure keybinding decision: Ctrl+Left/Right always switch tabs (this, rather
 * than plain Tab, avoids fighting with the Document widget system's own
 * default Tab-cycles-focus behaviour, and avoids colliding with normal text
 * entry in the talkable pane's input box). Ctrl+C quits regardless of focus.
 */
export function interpretKey(name: string): KeyAction {
  if (name === 'CTRL_RIGHT') return 'next-pane';
  if (name === 'CTRL_LEFT') return 'prev-pane';
  if (name === 'CTRL_C') return 'quit';
  return 'none';
}

interface PaneWidgets {
  container: Container;
  textBox: TextBox;
  log: PaneEntryLog;
}

/** Widget constructors, injectable so tests can substitute lightweight fakes. */
export interface TuiWidgetClasses {
  Document: typeof Document;
  Container: typeof Container;
  TextBox: typeof TextBox;
  InlineInput: typeof InlineInput;
}

const defaultWidgets: TuiWidgetClasses = {
  Document,
  Container,
  TextBox,
  InlineInput,
};

export interface TuiOptions {
  term?: Terminal;
  hideReasoning?: boolean;
  widgets?: TuiWidgetClasses;
}

const TAB_BAR_ROW = 1;
const INPUT_ROW_HEIGHT = 1;

/**
 * Orchestrates the full-screen multi-pane view: creates/destroys terminal-kit
 * widgets per pane, forwards SSE events to each pane's {@link PaneEntryLog},
 * and shows an {@link InlineInput} only when the active pane is talkable.
 */
export class Tui {
  private readonly term: Terminal;
  private readonly widgetClasses: TuiWidgetClasses;
  private readonly hideReasoning: boolean;
  private readonly document: Document;
  private readonly manager = new PaneManager();
  private readonly panes = new Map<string, PaneWidgets>();
  private input: InlineInput | null = null;
  private inputPaneId: string | null = null;
  private submitHandler: ((message: string) => void) | null = null;
  private quitHandler: (() => void) | null = null;

  constructor(opts: TuiOptions = {}) {
    this.term = opts.term ?? sharedTerminal;
    this.widgetClasses = opts.widgets ?? defaultWidgets;
    this.hideReasoning = opts.hideReasoning ?? false;
    this.term.fullscreen(true);
    this.term.grabInput(true);
    this.document = new this.widgetClasses.Document({
      outputDst: this.term,
      eventSource: this.term,
    });
    this.term.on('key', (name: string) => this.handleKey(name));
    this.term.on('resize', () => this.layout());
  }

  /** Registers the callback fired when the user submits a message. */
  onSubmit(handler: (message: string) => void): void {
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

  /** Adds a new tab for an agent (talkable = the root agent the user can address). */
  addPane(spec: PaneSpec): void {
    this.manager.addPane(spec);
    const container = new this.widgetClasses.Container({
      parent: this.document,
      hidden: true,
    });
    const textBox = new this.widgetClasses.TextBox({
      parent: container,
      scrollable: true,
      vScrollBar: true,
      wordWrap: true,
      lineWrap: true,
    });
    this.panes.set(spec.id, {
      container,
      textBox,
      log: new PaneEntryLog(this.hideReasoning),
    });
    this.layout();
    this.refresh();
  }

  /** Removes a pane (e.g. a consultation follower whose agent finished). */
  removePane(id: string): void {
    const widgets = this.panes.get(id);
    if (widgets) {
      widgets.container.destroy();
      this.panes.delete(id);
    }
    this.manager.removePane(id);
    this.layout();
    this.refresh();
  }

  /** Appends one SSE event to the named pane and redraws it if active. */
  appendEvent(paneId: string, event: SseEvent): void {
    const widgets = this.panes.get(paneId);
    if (!widgets) return;
    widgets.log.append(event);
    if (this.manager.activePane?.id === paneId) this.redrawActivePane();
  }

  /** Tears down fullscreen/input capture, restoring the normal terminal. */
  stop(): void {
    this.input?.destroy();
    this.term.grabInput(false);
    this.term.fullscreen(false);
  }

  private handleKey(name: string): void {
    const action = interpretKey(name);
    if (action === 'next-pane') {
      this.manager.next();
      this.refresh();
    } else if (action === 'prev-pane') {
      this.manager.prev();
      this.refresh();
    } else if (action === 'quit') {
      if (this.quitHandler) {
        this.quitHandler();
      } else {
        this.stop();
        this.term.processExit(0);
      }
    }
  }

  /** Repositions every pane's container to fill the area between the tab bar and the input row. */
  private layout(): void {
    const height = this.term.height - TAB_BAR_ROW - INPUT_ROW_HEIGHT;
    for (const { container } of this.panes.values()) {
      container.resize({
        x: 0,
        y: TAB_BAR_ROW,
        width: this.term.width,
        height: Math.max(height, 1),
      });
    }
    this.redrawActivePane();
  }

  /** Shows only the active pane's container, redraws the tab bar, and updates the input box. */
  private refresh(): void {
    for (const { container } of this.panes.values()) container.hide();
    const active = this.manager.activePane;
    if (active) this.panes.get(active.id)?.container.show();
    this.renderTabBar();
    this.redrawActivePane();
    this.updateInput();
  }

  private redrawActivePane(): void {
    const active = this.manager.activePane;
    if (!active) return;
    const widgets = this.panes.get(active.id);
    if (!widgets) return;
    const width = widgets.textBox.outputWidth || this.term.width;
    widgets.textBox.setContent(widgets.log.render(width).join('\n'));
    widgets.textBox.scrollToBottom();
  }

  private renderTabBar(): void {
    const panes = this.manager.panesInOrder;
    const active = this.manager.activePane;
    const label = (p: PaneSpec) =>
      p.id === active?.id ? `[${p.label}]` : ` ${p.label} `;
    const line = panes.map(label).join(' | ');
    this.term.moveTo(1, TAB_BAR_ROW);
    this.term.eraseLine();
    this.term(line);
  }

  /**
   * Creates/destroys the input box, but only actually rebuilds it when the
   * active pane's talkability changed or `force` is set. Without this guard,
   * every pane add/remove/switch would rebuild the input box even when the
   * active pane didn't change, silently wiping whatever the user was
   * mid-typing in the still-active, still-talkable root pane. `force` is used
   * after a submit, where the box must be rebuilt to clear the just-submitted
   * text even though the active pane hasn't changed.
   */
  private updateInput(force = false): void {
    const activeId = this.manager.activePane?.id ?? null;
    const shouldShow = this.manager.inputEnabled;
    if (
      !force &&
      activeId === this.inputPaneId &&
      (this.input !== null) === shouldShow
    ) {
      return;
    }
    this.input?.destroy();
    this.input = null;
    this.inputPaneId = activeId;
    if (!shouldShow) return;
    this.input = new this.widgetClasses.InlineInput({
      parent: this.document,
      x: 0,
      y: this.term.height,
      width: this.term.width,
      value: '',
    });
    this.input.on('submit', (value: unknown) => {
      const message = typeof value === 'string' ? value.trim() : '';
      if (message) this.submitHandler?.(message);
      this.updateInput(true);
    });
    this.document.giveFocusTo(this.input);
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
