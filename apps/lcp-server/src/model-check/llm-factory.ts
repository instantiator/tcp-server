import { LlmConfig } from '@lcp/shared';
import { ChatOpenAI } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

/**
 * Builds a {@link BaseChatModel} from the given {@link LlmConfig}.
 *
 * - `'lm-studio'`: OpenAI-compatible local endpoint (requires `baseUrl`)
 * - `'openai'`: hosted OpenAI (requires the env var named by `apiKeyEnvVar`)
 *
 * @throws if the provider is unrecognised or required config is missing
 */
export function buildChatModel(config: LlmConfig): BaseChatModel {
  switch (config.provider) {
    case 'lm-studio': {
      // Resolve API key from env; fall back to a placeholder when LM Studio
      // is running without authentication (key must be non-empty for the SDK)
      const lmKey = config.apiKeyEnvVar
        ? process.env[config.apiKeyEnvVar]
        : undefined;
      return new ChatOpenAI({
        model: config.model,
        configuration: { baseURL: config.baseUrl },
        apiKey: lmKey ?? 'lm-studio',
      });
    }

    case 'openai': {
      const key = config.apiKeyEnvVar
        ? process.env[config.apiKeyEnvVar]
        : undefined;
      return new ChatOpenAI({ model: config.model, apiKey: key });
    }

    default:
      throw new Error(`Unsupported LLM provider: ${config.provider}`);
  }
}
