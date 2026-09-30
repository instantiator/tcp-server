import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOpenAI } from '@langchain/openai';
import { DEFAULT_LLM_TIMEOUT_MS } from '../config/defaults';
import type { LlmConfig } from '../models/LlmConfig.model';
import { findProvider } from './provider-catalogue';

/**
 * Builds a {@link BaseChatModel} from the given {@link LlmConfig}.
 *
 * Every provider in {@link PROVIDER_CATALOGUE} is reached through its
 * OpenAI-compatible API, so each one is a `ChatOpenAI` pointed at `baseUrl`.
 * With no `baseUrl`, the OpenAI SDK's own default (hosted OpenAI) applies.
 *
 * Local servers usually run without authentication, so they get a placeholder
 * key when none is set; the OpenAI SDK refuses to start without one.
 *
 * @throws if the provider isn't in the catalogue
 */
export function buildChatModel(config: LlmConfig): BaseChatModel {
  // `||` (not `??`): NestJS's ConfigService can surface an unset env var as
  // `''` rather than `undefined` (Joi's `.empty('')` coercion isn't applied
  // to its process.env fallback path), and 0 is never a meaningful timeout.
  const timeout = config.timeoutMs || DEFAULT_LLM_TIMEOUT_MS;
  const template = findProvider(config.provider);
  if (!template) {
    throw new Error(`Unsupported LLM provider: ${config.provider}`);
  }
  return new ChatOpenAI({
    model: config.model,
    configuration: config.baseUrl ? { baseURL: config.baseUrl } : undefined,
    apiKey:
      config.apiKey || (template.kind === 'remote' ? undefined : template.id),
    timeout,
  });
}
