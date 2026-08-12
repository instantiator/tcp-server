// The one place terminal colour codes live. A surface renders LogEntries
// through a StyleBackend, so the entry/format logic stays colour-agnostic and
// the same lines can be produced as terminal-kit markup (TUI) or raw ANSI (a
// TTY stdout).

import { escapeMarkup } from '../tui/tui-format';
import type { EntryStyle, StyleBackend } from '@tcp/shared';

// The style model and the plain backend now live in @tcp/shared alongside the
// entry renderer that consumes them; only these two terminal backends are
// specific to the CLI. Re-exported so this file stays the one place a terminal
// surface asks for a style backend.
export type { EntryStyle, StyleBackend } from '@tcp/shared';
export { plainStyle } from '@tcp/shared';

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
