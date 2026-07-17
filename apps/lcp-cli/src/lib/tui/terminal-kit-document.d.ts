// Minimal ambient declarations for terminal-kit's "Document" widget API
// (Document/TextBox/InlineInput). The installed @types/terminal-kit (2.5.7)
// only covers the low-level terminal API (colors, cursor movement, raw
// key/resize events, ScreenBuffer) and predates these widgets. These
// declarations were written against the actual terminal-kit 3.1.3 sources
// (lib/document/*.js) — only the constructor options and members tui.ts
// actually uses are declared, not the full API surface.
//
// Behaviours worth knowing (from the sources, load-bearing for tui.ts):
// - Elements default to 1×1 when no width/height is given.
// - A Document pins itself at outputDst coordinates (1,1); child x/y are
//   0-based within it, so child rows 0..height-1 map onto the full terminal.
// - Container.resize() only resizes the internal ScreenBuffer, NOT the
//   element's drawn size/position — which is why tui.ts sizes TextBoxes
//   directly via setSizeAndPosition() instead of nesting them in Containers.

// The empty export makes this a module (rather than a global script), which
// is what makes the `declare module` below augment the existing
// @types/terminal-kit declarations instead of replacing them.
export {};

declare module 'terminal-kit' {
  export interface ElementOptions {
    parent?: Element;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    hidden?: boolean;
    content?: string;
    disabled?: boolean;
  }

  export class Element {
    constructor(options?: ElementOptions);
    outputX: number;
    outputY: number;
    outputWidth: number;
    outputHeight: number;
    hidden: boolean;
    disabled: boolean;
    /** Key-name → user-action map; assigning on an instance shadows the prototype's bindings. */
    keyBindings: Record<string, string>;
    show(noDraw?: boolean): void;
    hide(noDraw?: boolean): void;
    destroy(isSubDestroy?: boolean, noDraw?: boolean): void;
    draw(): void;
    on(event: string, handler: (...args: unknown[]) => void): void;
  }

  export interface DocumentOptions {
    /** Draw target: a Terminal (production) or a ScreenBuffer (tests). */
    outputDst?: unknown;
    /** Emitter of 'key'/'mouse'/'resize' events; the terminal in production. */
    eventSource?: unknown;
  }

  export class Document extends Element {
    constructor(options?: DocumentOptions);
    giveFocusTo(element: Element): void;
    /**
     * terminal-kit's own `eventSource` 'resize' listener — already bound to
     * the instance in the constructor (`this.onEventSourceResize =
     * this.onEventSourceResize.bind(this)`), hence `this: void` here: it's
     * safe to extract and call standalone. Resizes the Document's viewport
     * to the raw (width, height) and redraws immediately. tui.ts reorders
     * this relative to its own resize handling — see its constructor.
     */
    onEventSourceResize(this: void, width: number, height: number): void;
    /**
     * Container.prototype.resize (inherited) — resizes the Document's own
     * internal compositing ScreenBuffer only (see the module note above); it
     * does not draw and does not touch any child's own outputWidth/
     * outputHeight/position. tui.ts calls this directly, ahead of its own
     * refresh()/layout(), so every widget is repositioned for the new size
     * before the buffer they draw into is ever drawn.
     */
    resize(options: {
      x?: number;
      y?: number;
      width: number;
      height: number;
    }): void;
  }

  export interface TextBoxOptions extends ElementOptions {
    scrollable?: boolean;
    vScrollBar?: boolean;
    wordWrap?: boolean;
    lineWrap?: boolean;
  }

  export class TextBox extends Element {
    constructor(options: TextBoxOptions);
    /** Columns available for text: outputWidth minus the scrollbar column, if any. */
    textAreaWidth: number;
    textAreaHeight: number;
    /** Vertical scroll offset: 0 = top, more negative = scrolled further down. */
    scrollY: number;
    setSizeAndPosition(options: {
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    }): void;
    setContent(content: string, hasMarkup?: boolean, dontDraw?: boolean): void;
    getContentSize(): { width: number; height: number };
    scroll(dx: number, dy: number, dontDraw?: boolean): void;
    /** Absolute scroll (null leaves that axis unchanged); same sign convention as `scrollY`. */
    scrollTo(x: number | null, y: number | null, dontDraw?: boolean): void;
    scrollToBottom(dontDraw?: boolean): void;
  }

  export interface InlineInputOptions extends ElementOptions {
    value?: string;
    /** Prompt text drawn before the editable area, e.g. `{ content: '> ' }`. */
    prompt?: { content: string };
  }

  /** One-line growable text input (extends EditableTextBox extends TextBox). */
  export class InlineInput extends TextBox {
    constructor(options: InlineInputOptions);
    getValue(): string;
    setValue(value: string, dontDraw?: boolean): void;
  }
}
