import { BaseMessage } from '@langchain/core/messages';
import { getEncoding } from '@langchain/core/utils/tiktoken';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { Injectable, Logger } from '@nestjs/common';
import type { Tiktoken } from 'js-tiktoken';
import { DEFAULT_LLM_CONTEXT_WINDOW } from '../config/defaults';

/**
 * Estimates token usage and evaluates context budget for an LLM context window.
 *
 * Token counts use the `cl100k_base` tiktoken encoding (GPT-4 / Claude compatible),
 * which is a close enough approximation for all currently supported providers.
 *
 * ponytail: move TRIGGER_PCT/TARGET_PCT to LcpRole.runConfig JSONB when per-role
 * tuning is needed.
 */
@Injectable()
export class ContextBudgetService {
  private readonly logger = new Logger(ContextBudgetService.name);

  /** Fraction of the context window at which compaction is triggered. */
  readonly TRIGGER_PCT = 0.8;
  /** Fraction of the context window that compaction aims to reach. */
  readonly TARGET_PCT = 0.6;
  /** Default context window size when not specified in {@link LlmConfig}. */
  readonly DEFAULT_WINDOW = DEFAULT_LLM_CONTEXT_WINDOW;

  private encoder: Tiktoken | null = null;

  /** Lazily initialises and caches the tiktoken encoder. */
  private async getEncoder(): Promise<Tiktoken> {
    if (!this.encoder) {
      this.encoder = await getEncoding('cl100k_base');
    }
    return this.encoder;
  }

  /**
   * Counts the tokens in a single string using the cached tiktoken encoder.
   * Falls back to a character-based heuristic if tiktoken is unavailable.
   */
  async countText(text: string): Promise<number> {
    try {
      const enc = await this.getEncoder();
      return enc.encode(text).length;
    } catch (err) {
      this.logger.warn(
        `tiktoken unavailable, falling back to char heuristic: ${String(err)}`,
      );
      return Math.ceil(text.length / 4);
    }
  }

  /**
   * Estimates the total token count for an array of {@link BaseMessage} instances.
   * Counts text content only — role metadata overhead is not included.
   */
  async countMessages(messages: BaseMessage[]): Promise<number> {
    let total = 0;
    for (const msg of messages) {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : JSON.stringify(msg.content);
      total += await this.countText(text);
    }
    return total;
  }

  /**
   * Estimates the token footprint of a bound-tools schema — the `tools` array
   * sent alongside every completion request. LangChain's `bindTools` sends
   * the full name/description/parameter-schema of every tool on every turn,
   * which is otherwise invisible to budget checks based on message content
   * alone. Converts each tool via the same `convertToOpenAITool` LangChain
   * uses internally, so the counted JSON matches what's actually sent.
   */
  async countTools(tools: DynamicStructuredTool[]): Promise<number> {
    let total = 0;
    for (const tool of tools) {
      total += await this.countText(JSON.stringify(convertToOpenAITool(tool)));
    }
    return total;
  }

  /** Returns `true` when `tokens` exceeds {@link TRIGGER_PCT} of `windowSize`. */
  isOverBudget(tokens: number, windowSize: number): boolean {
    return !!windowSize && tokens / windowSize > this.TRIGGER_PCT;
  }

  /** Returns `true` when `tokens` is at or below {@link TARGET_PCT} of `windowSize`. */
  isAtTarget(tokens: number, windowSize: number): boolean {
    return !!windowSize && tokens / windowSize <= this.TARGET_PCT;
  }

  /** Computes the percentage of the window consumed, rounded to one decimal place. */
  pct(tokens: number, windowSize: number): number {
    return windowSize ? Math.round((tokens / windowSize) * 1000) / 10 : 0;
  }
}
