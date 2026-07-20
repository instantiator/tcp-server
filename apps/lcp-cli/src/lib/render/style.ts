// The one place colour codes live. Every surface renders LogEntries through a
// StyleBackend, so the entry/format logic stays colour-agnostic and the same
// lines can be produced as terminal-kit markup (TUI), raw ANSI (a TTY stdout),
// or plain text (piped stdout and byte-exact tests).

import { escapeMarkup } from '../tui/tui-format';

/** The visual role of a rendered line, mapped to a colour by the backend. */
export type EntryStyle =
  | 'heading'
  | 'state'
  | 'llm'
  | 'json'
  | 'reasoning'
  | 'response'
  | 'user';

/** Paints and escapes text for one output surface. The only home for colour codes. */
export interface StyleBackend {
  /** Wraps `text` in this style's colour codes. */
  paint(style: EntryStyle, text: string): string;
  /** Escapes text so the surface renders it literally (`^`→`^^` for markup; identity otherwise). */
  escape(text: string): string;
}

/** No colour, no escaping — used for non-TTY stdout and byte-exact tests. */
export const plainStyle: StyleBackend = {
  paint: (_style, text) => text,
  escape: (text) => text,
};

/** Raw-ANSI backend for a colour TTY (mirrors the old `render.ts` constants). */
const ANSI: Record<EntryStyle, string> = {
  heading: '\x1b[1m', // bold
  state: '\x1b[96m', // bright cyan
  llm: '\x1b[95m', // bright magenta
  json: '\x1b[95m', // bright magenta (tool call/result blocks)
  reasoning: '\x1b[90m', // grey
  response: '\x1b[37m', // white
  user: '\x1b[92m', // bright green
};
const ANSI_RESET = '\x1b[0m';

export const ansiStyle: StyleBackend = {
  paint: (style, text) => `${ANSI[style]}${text}${ANSI_RESET}`,
  escape: (text) => text,
};

/** terminal-kit caret-markup backend for the TUI (see `tui.ts`'s colour use). */
const MARKUP: Record<EntryStyle, string> = {
  heading: '^+', // bold
  state: '^C', // cyan
  llm: '^M', // magenta
  json: '^M',
  reasoning: '^K', // grey
  response: '', // default foreground
  user: '^G', // green
};

export const markupStyle: StyleBackend = {
  paint: (style, text) => {
    const code = MARKUP[style];
    return code ? `${code}${text}^:` : text;
  },
  escape: escapeMarkup,
};
