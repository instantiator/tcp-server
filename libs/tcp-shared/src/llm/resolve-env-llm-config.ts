import { ConfigService } from '@nestjs/config';
import type { LlmConfig } from '../models/LlmConfig.model';

/**
 * Builds an {@link LlmConfig} from environment variables as the last-resort
 * fallback in the resolution chain (role → company → env → fail).
 * Returns `null` when `LLM_PROVIDER` or `LLM_MODEL` are not set.
 */
export function resolveEnvLlmConfig(config: ConfigService): LlmConfig | null {
  const provider = config.get<string>('LLM_PROVIDER');
  const model = config.get<string>('LLM_MODEL');
  if (!provider || !model) return null;
  return {
    provider,
    model,
    baseUrl: config.get<string>('LLM_BASE_URL'),
    apiKey: config.get<string>('LLM_API_KEY'),
    contextWindow: config.get<number>('LLM_CONTEXT_WINDOW'),
    timeoutMs: config.get<number>('LLM_TIMEOUT_MS'),
  };
}
