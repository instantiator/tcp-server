/**
 * Shared scan logic for "first defined value wins" configuration precedence
 * (e.g. role overrides company overrides a baked-in default). Subclasses
 * supply the ordered sources and the terminal default; this base class does
 * the null-coalescing walk once so every precedence-chain resolver (LLM
 * config, system prompt template, ...) stays consistent and easy to extend.
 *
 * Not used for additive resolution (e.g. the MCP server list, which unions
 * every source instead of picking one) — that's a different shape with no
 * scan logic to share, so it stays a plain function instead.
 */
export abstract class PrecedenceResolver<T> {
  protected abstract getSources(): Array<T | null | undefined>;
  protected abstract getDefault(): T | undefined;

  resolve(): T | undefined {
    for (const source of this.getSources()) {
      if (source !== null && source !== undefined) return source;
    }
    return this.getDefault();
  }
}
