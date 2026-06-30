import { AIMessage } from '@langchain/core/messages';
import { Logger } from '@nestjs/common';

/**
 * Recovers answers from "thinking" models that put their entire response in
 * a provider-specific `reasoning_content` field and leave `content` blank —
 * observed with Qwen3, DeepSeek-R1, and similar reasoning models served
 * through OpenAI-compatible local endpoints (e.g. LM Studio). LangChain's
 * OpenAI converter preserves the field on `additional_kwargs.reasoning_content`
 * even though it doesn't surface it as `content`, so the answer is recoverable.
 *
 * Detection is signal-based rather than an allowlist of model names: any
 * model could exhibit this quirk, and a list would only ever be reactive to
 * ones already seen. "`content` empty, `reasoning_content` populated" is
 * specific enough on its own.
 */
export class ReasoningContentRecovery {
  static recover(message: AIMessage, logger?: Logger): AIMessage {
    const content =
      typeof message.content === 'string' ? message.content.trim() : '';
    if (content) return message;

    const reasoning: unknown = message.additional_kwargs?.reasoning_content;
    if (typeof reasoning !== 'string' || !reasoning.trim()) return message;

    const model: unknown = message.response_metadata?.model_name;
    const modelName = typeof model === 'string' ? model : 'unknown model';
    logger?.warn(
      `Model "${modelName}" returned its answer in reasoning_content instead of content — recovering it.`,
    );

    message.content = reasoning.trim();
    return message;
  }
}
