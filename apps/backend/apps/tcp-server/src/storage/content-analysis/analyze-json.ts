/** Analyzes JSON/JSONC content: array vs. object shape, sample keys. */
export function analyzeJson(
  base: Record<string, unknown>,
  content: string,
  ext: string,
): Record<string, unknown> {
  const result = { ...base };
  try {
    // Strip // comments for jsonc
    const stripped =
      ext === '.jsonc' ? content.replace(/^\s*\/\/.*$/gm, '') : content;
    const parsed: unknown = JSON.parse(stripped);
    if (Array.isArray(parsed)) {
      result.format = 'json-array';
      result.length = parsed.length;
      if (
        parsed.length > 0 &&
        typeof parsed[0] === 'object' &&
        parsed[0] !== null
      ) {
        result.sampleKeys = Object.keys(parsed[0] as object).slice(0, 10);
      }
    } else if (typeof parsed === 'object' && parsed !== null) {
      result.format = 'json-object';
      result.keys = Object.keys(parsed);
    }
  } catch {
    result.format = 'json-invalid';
  }
  return result;
}
