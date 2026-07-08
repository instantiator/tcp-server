/** Fallback analysis for unrecognised formats: plain-text line count. */
export function analyzeFallback(
  base: Record<string, unknown>,
  content: string,
): Record<string, unknown> {
  return { ...base, format: 'text', lineCount: content.split('\n').length };
}
