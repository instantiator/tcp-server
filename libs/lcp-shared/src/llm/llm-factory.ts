import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOpenAI } from '@langchain/openai';
import type { LlmConfig } from '../models/LlmConfig.model';

/** Default per-request LLM timeout. Local models can be slow; 30 min avoids premature drops. */
const DEFAULT_LLM_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Builds a {@link BaseChatModel} from the given {@link LlmConfig}.
 *
 * - `'lm-studio'`: OpenAI-compatible local endpoint (requires `baseUrl`).
 *   Falls back to the placeholder `'lm-studio'` when no `apiKey` is set,
 *   since LM Studio ignores the key value when running without authentication.
 * - `'openai'`: hosted OpenAI (requires `apiKey`)
 *
 * @throws if the provider is unrecognised or required config is missing
 */
export function buildChatModel(config: LlmConfig): BaseChatModel {
  const timeout = config.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  switch (config.provider) {
    case 'lm-studio':
      return new ChatOpenAI({
        model: config.model,
        configuration: { baseURL: config.baseUrl },
        apiKey: config.apiKey ?? 'lm-studio',
        timeout,
      });

    case 'openai':
      return new ChatOpenAI({
        model: config.model,
        apiKey: config.apiKey,
        timeout,
      });

    default:
      throw new Error(`Unsupported LLM provider: ${config.provider}`);
  }
}
