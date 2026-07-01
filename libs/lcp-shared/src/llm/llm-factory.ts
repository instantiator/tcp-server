import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOpenAI } from '@langchain/openai';
import { DEFAULT_LLM_TIMEOUT_MS } from '../config/defaults';
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
  // `||` (not `??`): NestJS's ConfigService can surface an unset env var as
  // `''` rather than `undefined` (Joi's `.empty('')` coercion isn't applied
  // to its process.env fallback path), and 0 is never a meaningful timeout.
  const timeout = config.timeoutMs || DEFAULT_LLM_TIMEOUT_MS;
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
