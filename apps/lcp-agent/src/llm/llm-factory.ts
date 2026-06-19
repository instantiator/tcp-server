import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOpenAI } from '@langchain/openai';
import { LlmConfig } from '@lcp/shared';

/**
 * Builds a {@link BaseChatModel} from the given {@link LlmConfig}.
 *
 * - `'lm-studio'`: OpenAI-compatible local endpoint (requires `baseUrl`).
 *   API key is resolved from the env var named by `apiKeyEnvVar`; falls back
 *   to a placeholder when LM Studio runs without authentication.
 * - `'openai'`: hosted OpenAI (requires the env var named by `apiKeyEnvVar`)
 *
 * @throws if the provider is unrecognised or required config is missing
 *
 * ponytail: duplicated from apps/lcp-server/src/model-check/llm-factory.ts —
 *   unify into libs/lcp-shared when a third consumer appears
 */
export function buildChatModel(config: LlmConfig): BaseChatModel {
  switch (config.provider) {
    case 'lm-studio': {
      const key = config.apiKeyEnvVar
        ? process.env[config.apiKeyEnvVar]
        : undefined;
      return new ChatOpenAI({
        model: config.model,
        configuration: { baseURL: config.baseUrl },
        apiKey: key ?? 'lm-studio',
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
