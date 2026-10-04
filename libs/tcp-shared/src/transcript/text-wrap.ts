// Pure word-wrap, shared by every output surface (TUI panes, eavesdrop,
// non-TUI chat) so long lines wrap consistently without duplicating the
// logic — no terminal-kit dependency, unlike tui-format.ts (which re-exports
// this for its own existing callers).

/**
 * Greedy word-wrap: splits on existing newlines (kept as hard breaks, with
 * trailing ones stripped), then packs words onto lines up to `width`.
 */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(width, 1);
  // Pop trailing empties rather than trim with /\n+$/, which backtracks
  // quadratically on a long run of newlines that doesn't reach the end.
  const paragraphs = text.split('\n');
  while (paragraphs.length > 1 && paragraphs.at(-1) === '') paragraphs.pop();
  const lines: string[] = [];
  for (const para of paragraphs) {
    const words = para.split(/[ \t]+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length > w && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
  }
  return lines.length > 0 ? lines : [''];
}
