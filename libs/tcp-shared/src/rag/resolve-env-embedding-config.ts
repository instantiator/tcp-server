import { ConfigService } from '@nestjs/config';
import type { LlmConfig } from '../models/LlmConfig.model';

/**
 * Builds an {@link LlmConfig} from environment variables as the last-resort
 * fallback for embeddings (company → env, see `resolveEmbeddingConfig`).
 * Returns `null` when `EMBEDDING_PROVIDER` or `EMBEDDING_MODEL` are not set.
 */
export function resolveEnvEmbeddingConfig(
  config: ConfigService,
): LlmConfig | null {
  const provider = config.get<string>('EMBEDDING_PROVIDER');
  const model = config.get<string>('EMBEDDING_MODEL');
  if (!provider || !model) return null;
  return {
    provider,
    model,
    baseUrl: config.get<string>('EMBEDDING_BASE_URL'),
    apiKey: config.get<string>('EMBEDDING_API_KEY'),
  };
}
