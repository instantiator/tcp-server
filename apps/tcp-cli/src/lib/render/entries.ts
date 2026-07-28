// The rendered-line model shared by every surface. A LogEntry is one logical
// block of output (a discrete event, or an accumulated reasoning/response
// stream); renderEntry turns it into fixed-width display lines through a
// StyleBackend. This is the single implementation of the two output shapes —
// line-only and content-bearing — that the old three switch blocks each
// re-derived differently.

import { isBlankText } from '../core/agent-log-format';
import { wrapText } from '../core/text-wrap';
import { EntryStyle, StyleBackend } from './style';

/** Placeholder shown in place of a whitespace-only or empty response. */
const BLANK_RESPONSE_MARKER = '(blank)';

/** Styles whose text renders as an indented content block rather than a trailing line segment. */
const BLOCK_STYLES: ReadonlySet<EntryStyle> = new Set<EntryStyle>([
  'reasoning',
  'response',
  'user',
  'json',
]);

/**
 * One logical block of log content. Generalises the old `PaneEntry`: `label`
 * is the `eventLabel()` shown after the timestamp; `json` marks `text` as
 * already-pretty-printed JSON to indent verbatim (not word-wrap).
 */
export interface LogEntry {
  style: EntryStyle;
  /** hh:mm:ss. */
  time: string;
  /** `<AuditEventType>[:kind…]` label; absent only for headings. */
  label?: string;
  /** Raw, unwrapped accumulated text (or pretty-printed JSON when `json`). */
  text: string;
  /** When true, `text` is pretty-printed JSON — indented verbatim, not wrapped. */
  json?: boolean;
}

/** Whether an entry renders as an indented content block (vs a single trailing line). */
function isBlock(entry: LogEntry): boolean {
  return entry.json === true || BLOCK_STYLES.has(entry.style);
}

/**
 * Renders one {@link LogEntry} to display lines at `width` columns through
 * `style`. Two shapes (`docs/prompts/010.5.1` B.2):
 * - **line-only** — `hh:mm:ss | label | text`, wrapped, whole line painted.
 * - **content-bearing** — a `hh:mm:ss | label |` header, a blank line, then the
 *   text indented two spaces (word-wrapped, or JSON indented verbatim).
 * The blank line separating entries is inserted by the buffer, not here.
 */
export function renderEntry(
  entry: LogEntry,
  width: number,
  style: StyleBackend,
): string[] {
  const header = `${entry.time} | ${entry.label ?? ''} |`;

  if (!isBlock(entry)) {
    const prefix = `${header} `;
    const wrapped = wrapText(entry.text, Math.max(width - prefix.length, 1));
    return (wrapped.length ? wrapped : ['']).map((line, i) =>
      style.paint(
        entry.style,
        i === 0 ? prefix + style.escape(line) : style.escape(line),
      ),
    );
  }

  const bodyText =
    entry.style === 'response' && isBlankText(entry.text)
      ? BLANK_RESPONSE_MARKER
      : entry.text;
  const bodyLines = entry.json
    ? bodyText.split('\n')
    : wrapText(bodyText, Math.max(width - 2, 1));
  return [
    style.paint(entry.style, header),
    '',
    ...bodyLines.map((line) =>
      style.paint(entry.style, `  ${style.escape(line)}`),
    ),
  ];
}
