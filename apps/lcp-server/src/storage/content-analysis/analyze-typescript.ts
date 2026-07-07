/** Analyzes TypeScript/JavaScript content: regex-extracted top-level declaration names. */
export function analyzeTypescript(
  base: Record<string, unknown>,
  content: string,
): Record<string, unknown> {
  const declarations: string[] = [];
  const patterns = [
    /^export\s+(?:default\s+)?(?:async\s+)?(?:class|function|interface|type|const|enum)\s+(\w+)/gm,
    /^(?:class|function|interface|type|const|enum)\s+(\w+)/gm,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      if (m[1] && !declarations.includes(m[1])) declarations.push(m[1]);
    }
  }
  return { ...base, format: 'typescript', declarations };
}
