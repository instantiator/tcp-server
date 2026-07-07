/** Analyzes YAML content: top-level key names (regex-based, not a real parse). */
export function analyzeYaml(
  base: Record<string, unknown>,
  content: string,
): Record<string, unknown> {
  const topLevelKeys = content
    .split('\n')
    .filter((l) => /^[a-zA-Z_][a-zA-Z0-9_]*\s*:/.test(l))
    .map((l) => l.split(':')[0].trim());
  return { ...base, format: 'yaml', topLevelKeys };
}
