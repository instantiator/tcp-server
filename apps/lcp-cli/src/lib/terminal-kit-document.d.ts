// Minimal ambient declarations for terminal-kit's "Document" widget API
// (Document/Container/TextBox/InlineInput). The installed @types/terminal-kit
// (2.5.7) only covers the low-level terminal API (colors, cursor movement,
// raw key/resize events) and predates these widgets, so they're declared here
// — only the constructor options and methods tui.ts actually calls, not the
// full API surface (mouse handling, menus, sliders, etc. are omitted).

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
    noDraw?: boolean;
  }

  export class Element {
    constructor(options?: ElementOptions);
    outputX: number;
    outputY: number;
    outputWidth: number;
    outputHeight: number;
    show(noDraw?: boolean): void;
    hide(noDraw?: boolean): void;
    destroy(isSubDestroy?: boolean, noDraw?: boolean): void;
    draw(isInitialInlineDraw?: boolean): void;
    on(event: string, handler: (...args: unknown[]) => void): void;
  }

  export interface DocumentOptions {
    outputDst?: unknown;
    eventSource?: unknown;
  }

  export class Document extends Element {
    constructor(options?: DocumentOptions);
    giveFocusTo(element: Element): void;
  }

  export class Container extends Element {
    constructor(options: ElementOptions);
    resize(to: { x: number; y: number; width: number; height: number }): void;
  }

  export interface TextBoxOptions extends ElementOptions {
    scrollable?: boolean;
    vScrollBar?: boolean;
    wordWrap?: boolean;
    lineWrap?: boolean;
  }

  export class TextBox extends Element {
    constructor(options: TextBoxOptions);
    /** Appends content and auto-scrolls to the bottom, like a log/console. */
    appendLog(content: string, dontDraw?: boolean): void;
    setContent(content: string, hasMarkup?: boolean, dontDraw?: boolean): void;
    scrollToBottom(dontDraw?: boolean): void;
  }

  export interface InlineInputOptions extends ElementOptions {
    value?: string;
  }

  export class InlineInput extends Element {
    constructor(options: InlineInputOptions);
    getValue(): string;
  }
}
