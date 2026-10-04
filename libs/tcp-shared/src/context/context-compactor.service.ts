import {
  BaseMessage,
  HumanMessage,
  RemoveMessage,
  SystemMessage,
  trimMessages,
} from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { Injectable, Logger } from '@nestjs/common';
import type { LlmIdentity, LlmUsage } from '../llm/llm-usage';
import { usageFromMessage } from '../llm/llm-usage';
import { ContextBudgetService } from './context-budget.service';

/** Result returned by {@link ContextCompactorService.trimHistory}. */
export interface TrimResult {
  /** Messages retained after trimming. */
  trimmed: BaseMessage[];
  /** IDs of messages removed from the history. */
  removedIds: string[];
  /** Human-readable description of what was done. */
  activity: string;
}

/**
 * Performs context compaction operations on LangGraph message histories.
 *
 * Two tiers of compaction:
 * - **Tier 1** (fast, no LLM): `trimHistory` uses `trimMessages` from
 *   `@langchain/core/messages` with tiktoken token counting. Handles the
 *   common case with no inference cost.
 * - **Tier 2** (LLM-assisted): `summariseMessage` compresses an individual
 *   message that is too large to fit even after trimming. Multiple calls
 *   can be run in parallel via `Promise.all`.
 */
@Injectable()
export class ContextCompactorService {
  private readonly logger = new Logger(ContextCompactorService.name);

  constructor(private readonly budget: ContextBudgetService) {}

  /**
   * Trims the message history to `maxTokens` using a sliding-window strategy.
   *
   * The system message is always retained. Oldest non-system messages are
   * removed first. Returns both the trimmed array and the IDs of removed messages
   * so the caller can apply `RemoveMessage` updates to the LangGraph checkpoint.
   */
  async trimHistory(
    messages: BaseMessage[],
    maxTokens: number,
  ): Promise<TrimResult> {
    const before = messages.length;
    const trimmed = await trimMessages(messages, {
      maxTokens,
      tokenCounter: (msgs) => this.budget.countMessages(msgs),
      strategy: 'last',
      includeSystem: true,
    });

    const trimmedIds = new Set(trimmed.map((m) => m.id));
    const removedIds = messages
      .filter((m) => m.id && !trimmedIds.has(m.id))
      .map((m) => m.id as string);

    const activity = `Trimmed history from ${before} to ${trimmed.length} messages (removed ${removedIds.length})`;
    this.logger.log(activity);
    return { trimmed, removedIds, activity };
  }

  /**
   * Builds `RemoveMessage` entries for each ID to be removed from the
   * LangGraph checkpoint state via `graph.updateState()`.
   */
  buildRemoveMessages(ids: string[]): RemoveMessage[] {
    return ids.map((id) => new RemoveMessage({ id }));
  }

  /**
   * Uses the provided LLM to compress a single message to bullet-point essentials.
   * Returns a new message of the same role with the summarised content.
   *
   * // TODO - before dropping, consider extracting essential information (decisions,
   * //   commitments, constraints) from messages marked for removal and storing as a
   * //   compact 'context anchor' message prepended to the history — implement when
   * //   information loss becomes a problem in practice (see ADR-013)
   */
  async summariseMessage(
    msg: BaseMessage,
    model: BaseChatModel,
    llm?: LlmIdentity,
    onUsage?: (usage: LlmUsage) => void,
  ): Promise<BaseMessage> {
    const originalContent =
      typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);

    const prompt = `Summarise the following message in as few tokens as possible. Preserve only essential information: decisions, facts, commitments, and constraints. Output only the summary with no preamble.\n\nMessage:\n${originalContent}`;

    try {
      const result = await model.invoke([new HumanMessage(prompt)]);
      this.reportUsage(result, llm, onUsage);
      const summary =
        typeof result.content === 'string' ? result.content.trim() : '';

      // Reconstruct a message of the same type with compacted content
      if (msg instanceof SystemMessage) {
        return new SystemMessage({ content: summary, id: msg.id });
      }
      return new HumanMessage({ content: `[Summary] ${summary}`, id: msg.id });
    } catch (err) {
      this.logger.warn(
        `summariseMessage failed for message ${msg.id ?? '?'}: ${String(err)} — keeping original`,
      );
      return msg;
    }
  }

  /**
   * Uses the provided LLM to compress a free-text section (e.g. a role description
   * or company environment block) to bullet-point essentials.
   */
  async compactSection(
    content: string,
    label: string,
    model: BaseChatModel,
    llm?: LlmIdentity,
    onUsage?: (usage: LlmUsage) => void,
  ): Promise<string> {
    const prompt = `Summarise the following "${label}" section in as few tokens as possible, as a bullet-point list of essential facts only. Output only the bullets.\n\n${content}`;
    try {
      const result = await model.invoke([new HumanMessage(prompt)]);
      this.reportUsage(result, llm, onUsage);
      return typeof result.content === 'string'
        ? result.content.trim()
        : content;
    } catch (err) {
      this.logger.warn(
        `compactSection("${label}") failed: ${String(err)} — keeping original`,
      );
      return content;
    }
  }

  /**
   * Reports one `model.invoke()` call's usage to the caller, when both an
   * {@link LlmIdentity} and a callback were given — omitted entirely for
   * callers that don't track compaction spend.
   */
  private reportUsage(
    result: { usage_metadata?: unknown },
    llm?: LlmIdentity,
    onUsage?: (usage: LlmUsage) => void,
  ): void {
    if (!llm || !onUsage) return;
    const usage = usageFromMessage(result, llm);
    if (usage) onUsage(usage);
  }
}
