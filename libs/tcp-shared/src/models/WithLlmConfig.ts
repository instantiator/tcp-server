import type { LlmConfig } from './LlmConfig.model';

/**
 * Marks an entity as carrying an optional LLM configuration, so callers can
 * treat role/company objects uniformly when resolving precedence between
 * them (see {@link LlmConfigResolver}) instead of reading differently-named
 * fields per entity.
 */
export interface WithLlmConfig {
  llmConfig?: LlmConfig | null;
}
