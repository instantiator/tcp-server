import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { MinioService } from '../storage/minio.service';
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
  /** MinIO object key where the overflow was stored, if applicable. */
  overflowKey?: string;
}

/**
 * Reviews incoming data (user messages, RAG results, MCP responses) before it
 * is added to the prompt context, to prevent a single large payload from
 * immediately blowing the context budget.
 *
 * Resolution order:
 * 1. Text fits within the remaining budget — pass through unchanged.
 * 2. A compacted version fits — return the compacted version.
 * 3. Compacted version still too large — if {@link MinioService} is available
 *    and `overflowPath` is provided, write the original to MinIO and return a
 *    short reference summary. Otherwise returns the best-effort compacted version.
 */
@Injectable()
export class IncomingDataGuardService {
  private readonly logger = new Logger(IncomingDataGuardService.name);

  constructor(
    private readonly budget: ContextBudgetService,
    private readonly compactor: ContextCompactorService,
    @Optional() private readonly minio?: MinioService,
  ) {}

  /**
   * Evaluates whether `text` fits in the remaining context budget and, if not,
   * compacts it using the provided `model`.
   *
   * When the compacted version is still over budget and both `overflowPath` and
   * a {@link MinioService} are available, the original text is written to MinIO
   * and a short reference summary is returned in its place.
   *
   * @param text - The incoming text to evaluate.
   * @param currentTokens - Tokens already consumed by existing context.
   * @param windowSize - Full context window size in tokens.
   * @param model - LLM used for summarisation if compaction is needed.
   * @param overflowPath - MinIO key prefix for overflow storage (e.g.
   *   `acme/tasks/{agentId}/context-overflow`). Sanitise before passing.
   */
  async check(
    text: string,
    currentTokens: number,
    windowSize: number,
    model: BaseChatModel,
    overflowPath?: string,
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

    if (stillOver && overflowPath && this.minio) {
      const overflowKey = `${overflowPath}/${Date.now()}.txt`;
      try {
        await this.minio.putRaw(overflowKey, text);
        const refText =
          `[Context overflow: original data (${incomingTokens} tokens) stored at ${overflowKey}. ` +
          `Summary:\n${compacted}]`;
        this.logger.log(
          `Context overflow stored at ${overflowKey} (${incomingTokens} tokens)`,
        );
        return {
          text: refText,
          compacted: true,
          activity: `Overflow stored at ${overflowKey}; summary injected`,
          overflowKey,
        };
      } catch (err) {
        this.logger.warn(
          `Failed to write context overflow to MinIO at ${overflowKey}: ${String(err instanceof Error ? err.message : err)} — falling back to best-effort compaction`,
        );
      }
    }

    const activity = `Incoming data compacted: ${incomingTokens}→${compactedTokens} tokens${stillOver ? ' (still over budget — best effort)' : ''}`;
    this.logger.log(activity);

    return { text: compacted, compacted: true, activity };
  }
}
