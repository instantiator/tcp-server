import type { LlmConfig } from './LlmConfig.model';

/**
 * Marks an entity as carrying an optional embedding configuration, so
 * callers can resolve it uniformly (see {@link EmbeddingConfigResolver})
 * instead of reading `embeddingConfig` off a specific entity type.
 */
export interface WithEmbeddingConfig {
  embeddingConfig?: LlmConfig | null;
}
