import type { LlmConfig } from '../models/LlmConfig.model';
import type { WithEmbeddingConfig } from '../models/WithEmbeddingConfig';
import { PrecedenceResolver } from './precedence-resolver';

/**
 * Resolves the {@link LlmConfig} to use for embeddings, in precedence order:
 * company → environment-configured fallback. Unlike {@link LlmConfigResolver}
 * there is no role-level override — embeddings are indexed per company
 * scope, not per role.
 *
 * @param company - The company whose knowledge/memory is being embedded (may be null).
 * @param envFallback - Value built from environment variables (e.g. via
 *   `resolveEnvEmbeddingConfig`), or undefined if none is configured.
 */
export class EmbeddingConfigResolver extends PrecedenceResolver<LlmConfig> {
  constructor(
    private readonly company: WithEmbeddingConfig | null | undefined,
    private readonly envFallback: LlmConfig | null | undefined,
  ) {
    super();
  }

  protected getSources(): Array<LlmConfig | null | undefined> {
    return [this.company?.embeddingConfig];
  }

  protected getDefault(): LlmConfig | undefined {
    return this.envFallback ?? undefined;
  }
}

/** Convenience wrapper: `new EmbeddingConfigResolver(company, envFallback).resolve()`. */
export function resolveEmbeddingConfig(
  company: WithEmbeddingConfig | null | undefined,
  envFallback: LlmConfig | null | undefined,
): LlmConfig | undefined {
  return new EmbeddingConfigResolver(company, envFallback).resolve();
}
