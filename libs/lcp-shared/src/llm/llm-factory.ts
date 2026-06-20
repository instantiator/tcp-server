import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOpenAI } from '@langchain/openai';
import type { LlmConfig } from '../models/LlmConfig.model';

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
  switch (config.provider) {
    case 'lm-studio':
      return new ChatOpenAI({
        model: config.model,
        configuration: { baseURL: config.baseUrl },
        apiKey: config.apiKey ?? 'lm-studio',
      });

    case 'openai':
      return new ChatOpenAI({ model: config.model, apiKey: config.apiKey });

    default:
      throw new Error(`Unsupported LLM provider: ${config.provider}`);
  }
}
