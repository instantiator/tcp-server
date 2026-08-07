/** Analyzes Markdown content: front-matter keys and heading structure. */
export function analyzeMarkdown(
  base: Record<string, unknown>,
  content: string,
): Record<string, unknown> {
  const lines = content.split('\n');
  const fmEnd = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  const frontmatterKeys =
    fmEnd > 0
      ? lines
          .slice(1, fmEnd)
          .filter((l) => l.includes(':'))
          .map((l) => l.split(':')[0].trim())
      : [];
  const headings = lines
    .filter((l) => /^#{1,6}\s/.test(l))
    .map((l) => {
      const m = l.match(/^(#{1,6})\s+(.+)/);
      return m ? { level: m[1].length, text: m[2].trim() } : null;
    })
    .filter(Boolean);
  return { ...base, format: 'markdown', frontmatterKeys, headings };
}
