// The style model and the plain backend. Every surface renders LogEntries
// through a StyleBackend, so the entry/format logic stays colour-agnostic and
// the same lines can be produced as terminal-kit markup (TUI), raw ANSI (a
// TTY stdout), or plain text (piped stdout, byte-exact tests, and the
// browser). The colour backends themselves (ANSI, terminal-kit markup) stay
// in the CLI, which is the only client that draws to a terminal.

/** The visual role of a rendered line, mapped to a colour by the backend. */
export type EntryStyle =
  'heading' | 'state' | 'llm' | 'json' | 'reasoning' | 'response' | 'user';

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
