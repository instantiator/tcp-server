/**
 * Parses repeatable `--filter key=value` options into a plain map. Later
 * occurrences of the same key win. Throws on a malformed `--filter` (missing
 * `=`).
 */
export function parseFilters(filters: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of filters) {
    const idx = raw.indexOf('=');
    if (idx === -1) {
      throw new Error(`Invalid --filter "${raw}", expected key=value`);
    }
    out[raw.slice(0, idx)] = raw.slice(idx + 1);
  }
  return out;
}
