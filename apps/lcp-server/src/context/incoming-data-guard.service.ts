import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { Injectable, Logger } from '@nestjs/common';
import { ContextBudgetService } from './context-budget.service';
import { ContextCompactorService } from './context-compactor.service';

/** Result returned by {@link IncomingDataGuardService.check}. */
export interface IncomingDataResult {
  /** The text to include in the prompt (original or compacted). */
  text: string;
  /** Whether the text was compacted before inclusion. */
  compacted: boolean;
  /** Human-readable description of what happened. */
  activity?: string;
}

/**
 * Reviews incoming data (user messages, RAG results, MCP responses) before it
 * is added to the prompt context, to prevent a single large payload from
 * immediately blowing the context budget.
 *
 * Resolution order:
 * 1. Text fits within the remaining budget — pass through unchanged.
 * 2. A compacted version fits — return the compacted version.
 * 3. Compacted version still too large — return the best-effort compacted
 *    version and log a warning.
 *
 * TODO - if compacted version still doesn't fit, store original in shared
 *   storage and include a reference summary — implement when MinIO/storage MCP
 *   is available (ADR-007)
 */
@Injectable()
export class IncomingDataGuardService {
  private readonly logger = new Logger(IncomingDataGuardService.name);

  constructor(
    private readonly budget: ContextBudgetService,
    private readonly compactor: ContextCompactorService,
  ) {}

  /**
   * Evaluates whether `text` fits in the remaining context budget and, if not,
   * compacts it using the provided `model`.
   *
   * @param text - The incoming text to evaluate.
   * @param currentTokens - Tokens already consumed by existing context.
   * @param windowSize - Full context window size in tokens.
   * @param model - LLM used for summarisation if compaction is needed.
   */
  async check(
    text: string,
    currentTokens: number,
    windowSize: number,
    model: BaseChatModel,
  ): Promise<IncomingDataResult> {
    const incomingTokens = await this.budget.countText(text);
    const totalTokens = currentTokens + incomingTokens;

    if (!this.budget.isOverBudget(totalTokens, windowSize)) {
      return { text, compacted: false };
    }

    this.logger.warn(
      `Incoming data (${incomingTokens} tokens) pushes context to ${totalTokens}/${windowSize} — compacting`,
    );

    const compacted = await this.compactor.compactSection(
      text,
      'incoming data',
      model,
    );
    const compactedTokens = await this.budget.countText(compacted);
    const stillOver = this.budget.isOverBudget(
      currentTokens + compactedTokens,
      windowSize,
    );

    const activity = `Incoming data compacted: ${incomingTokens}→${compactedTokens} tokens${stillOver ? ' (still over budget — best effort)' : ''}`;
    this.logger.log(activity);

    // TODO - if still over budget, store original in shared storage and substitute
    //   a short reference summary here (implement when ADR-007 storage is available)

    return { text: compacted, compacted: true, activity };
  }
}
