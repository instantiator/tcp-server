import { BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import { Injectable, Logger } from '@nestjs/common';
import { AuditEvent, AuditEventType, LcpAgent, LcpRole } from '@lcp/shared';
import { Repository } from 'typeorm';
import { AgentEventService } from '../events/agent-event.service';
import { ContextBudgetService } from './context-budget.service';
import { ContextCompactorService } from './context-compactor.service';
import { IncomingDataGuardService } from './incoming-data-guard.service';
import type { CompactionReport, CompactionSnapshot } from './context.types';

/** Minimal checkpoint state shape that context management needs from LangGraph. */
interface CheckpointState {
  values: Record<string, unknown>;
}

/**
 * Minimal interface for the LangGraph compiled graph methods used by
 * {@link ContextManagerService}. The full `CompiledStateGraph` generic type
 * is complex; this structural type captures only what context management needs.
 */
interface CheckpointableGraph {
  getState(config: RunnableConfig): Promise<CheckpointState>;
  updateState(
    config: RunnableConfig,
    values: Record<string, unknown>,
  ): Promise<RunnableConfig>;
}

/** Result returned by {@link ContextManagerService.prepare}. */
export interface PrepareResult {
  /** The message text to send (may have been compacted by the incoming-data guard). */
  message: string;
  /** Compaction report, or `null` if no compaction was needed. */
  report: CompactionReport | null;
}

/**
 * Orchestrates context budget checks and compaction for each chat turn.
 *
 * Before a new message is invoked on the graph, this service:
 * 1. Checks the incoming message size via {@link IncomingDataGuardService}.
 * 2. Loads the current checkpoint state and counts total tokens.
 * 3. If over budget, runs Tier-1 (trim_messages) compaction via
 *    {@link ContextCompactorService} and writes the result back to the
 *    checkpoint using `graph.updateState()`.
 * 4. If still over budget, runs Tier-2 (LLM summarisation) on oversized messages.
 * 5. Emits {@link AgentEvent} SSE events and writes {@link AuditEvent} rows
 *    before and after compaction.
 *
 * When no compaction is needed the method returns immediately with no side effects.
 */
@Injectable()
export class ContextManagerService {
  private readonly logger = new Logger(ContextManagerService.name);

  constructor(
    private readonly budget: ContextBudgetService,
    private readonly compactor: ContextCompactorService,
    private readonly guard: IncomingDataGuardService,
    private readonly events: AgentEventService,
  ) {}

  /**
   * Checks context budget and runs compaction if needed before a graph invocation.
   *
   * Must be called after the graph and checkpointer are set up but before
   * `graph.invoke()`. For the first message (no checkpoint yet), only the
   * incoming-data guard runs.
   *
   * @param agentId - Used for SSE event routing.
   * @param message - Incoming user message text.
   * @param model - LLM used for Tier-2 summarisation if needed.
   * @param windowSize - Context window size in tokens.
   * @param graph - Compiled LangGraph graph with checkpoint access.
   * @param config - LangGraph runnable config (must include `thread_id`).
   * @param isFirstMessage - When `true`, skips checkpoint state loading.
   * @param agent - Current agent record (for audit logging).
   * @param role - Agent's role (for audit logging).
   * @param auditRepo - TypeORM repository for writing {@link AuditEvent} rows.
   */
  async prepare(
    agentId: string,
    message: string,
    model: BaseChatModel,
    windowSize: number,
    graph: CheckpointableGraph,
    config: RunnableConfig,
    isFirstMessage: boolean,
    agent: LcpAgent,
    role: LcpRole,
    auditRepo: Repository<AuditEvent>,
  ): Promise<PrepareResult> {
    const startMs = Date.now();
    const activities: string[] = [];
    const strategies: string[] = [];

    const currentTokens = isFirstMessage
      ? 0
      : await this.loadCheckpointTokens(graph, config);

    const guardResult = await this.guard.check(
      message,
      currentTokens,
      windowSize,
      model,
    );
    if (guardResult.compacted && guardResult.activity) {
      activities.push(guardResult.activity);
      strategies.push('compact_incoming');
    }

    if (isFirstMessage) {
      return {
        message: guardResult.text,
        report:
          activities.length > 0
            ? this.buildReport(
                strategies,
                activities,
                startMs,
                currentTokens,
                windowSize,
                await this.budget.countText(guardResult.text),
                windowSize,
              )
            : null,
      };
    }

    const incomingTokens = await this.budget.countText(guardResult.text);
    const totalTokens = currentTokens + incomingTokens;

    if (!this.budget.isOverBudget(totalTokens, windowSize)) {
      return {
        message: guardResult.text,
        report:
          activities.length > 0
            ? this.buildReport(
                strategies,
                activities,
                startMs,
                totalTokens,
                windowSize,
                totalTokens,
                windowSize,
              )
            : null,
      };
    }

    this.logger.warn(
      `Agent ${agentId}: context at ${this.budget.pct(totalTokens, windowSize)}% (${totalTokens}/${windowSize}) — compacting`,
    );
    this.events.emit(agentId, {
      kind: 'compaction_started',
      timestamp: new Date().toISOString(),
      data: {
        tokensBefore: totalTokens,
        windowSize,
        pct: this.budget.pct(totalTokens, windowSize),
        strategies: [],
      },
    });
    await this.saveAudit(auditRepo, agent, role, {
      event: 'compaction_triggered',
      tokensBefore: totalTokens,
      windowSize,
      pct: this.budget.pct(totalTokens, windowSize),
    });

    const tokensBefore = totalTokens;
    let tokensAfter = totalTokens;

    // Tier 1: sliding-window trim (no LLM)
    const state = await graph.getState(config);
    const historyMessages = this.extractMessages(state);

    if (historyMessages.length > 0) {
      const targetTokens = Math.floor(windowSize * this.budget.TARGET_PCT);
      const trimResult = await this.compactor.trimHistory(
        historyMessages,
        targetTokens,
      );

      if (trimResult.removedIds.length > 0) {
        strategies.push('trim_messages');
        activities.push(trimResult.activity);

        const removes = this.compactor.buildRemoveMessages(
          trimResult.removedIds,
        );
        await graph.updateState(config, {
          messages: removes,
        });

        tokensAfter = await this.loadCheckpointTokens(graph, config);
        tokensAfter += incomingTokens;
      }
    }

    // Tier 2: LLM summarisation for oversized messages (runs in parallel)
    if (!this.budget.isAtTarget(tokensAfter, windowSize)) {
      const reloaded = this.extractMessages(await graph.getState(config));
      const targetPerMsg = Math.floor(
        (windowSize * this.budget.TARGET_PCT) / Math.max(reloaded.length, 1),
      );

      const oversized: BaseMessage[] = [];
      for (const msg of reloaded) {
        const tokens = await this.budget.countMessages([msg]);
        if (tokens > targetPerMsg) oversized.push(msg);
      }

      if (oversized.length > 0) {
        strategies.push('summarise_message');
        const summaries = await Promise.all(
          oversized.map((m) => this.compactor.summariseMessage(m, model)),
        );

        const removes = this.compactor.buildRemoveMessages(
          oversized.map((m) => m.id as string).filter(Boolean),
        );
        await graph.updateState(config, {
          messages: [...(removes as BaseMessage[]), ...summaries],
        });

        activities.push(
          `Summarised ${oversized.length} oversized message(s) via LLM`,
        );
        tokensAfter = await this.loadCheckpointTokens(graph, config);
        tokensAfter += incomingTokens;
      }
    }

    this.events.emit(agentId, {
      kind: 'compaction_complete',
      timestamp: new Date().toISOString(),
      data: {
        tokensAfter,
        windowSize,
        pctAfter: this.budget.pct(tokensAfter, windowSize),
        durationMs: Date.now() - startMs,
        activities,
      },
    });
    await this.saveAudit(auditRepo, agent, role, {
      event: 'compaction_complete',
      tokensAfter,
      windowSize,
      pctAfter: this.budget.pct(tokensAfter, windowSize),
      durationMs: Date.now() - startMs,
      activities,
    });

    this.logger.log(
      `Agent ${agentId}: compaction complete — ${tokensBefore}→${tokensAfter} tokens in ${Date.now() - startMs}ms`,
    );

    return {
      message: guardResult.text,
      report: this.buildReport(
        strategies,
        activities,
        startMs,
        tokensBefore,
        windowSize,
        tokensAfter,
        windowSize,
      ),
    };
  }

  /** Loads current checkpoint state and counts its message tokens. */
  private async loadCheckpointTokens(
    graph: CheckpointableGraph,
    config: RunnableConfig,
  ): Promise<number> {
    const state = await graph.getState(config);
    return this.budget.countMessages(this.extractMessages(state));
  }

  /**
   * Extracts the messages array from a checkpoint state.
   * Returns an empty array when the checkpoint has no messages (first turn).
   */
  private extractMessages(state: CheckpointState): BaseMessage[] {
    const msgs = state.values['messages'];
    if (!Array.isArray(msgs)) return [];
    return msgs as BaseMessage[];
  }

  private buildReport(
    strategies: string[],
    activities: string[],
    startMs: number,
    tokensBefore: number,
    windowBefore: number,
    tokensAfter: number,
    windowAfter: number,
  ): CompactionReport {
    const before: CompactionSnapshot = {
      tokens: tokensBefore,
      windowSize: windowBefore,
      pct: this.budget.pct(tokensBefore, windowBefore),
    };
    const after: CompactionSnapshot = {
      tokens: tokensAfter,
      windowSize: windowAfter,
      pct: this.budget.pct(tokensAfter, windowAfter),
    };
    return {
      strategies,
      activities,
      duration: Date.now() - startMs,
      before,
      after,
    };
  }

  private async saveAudit(
    auditRepo: Repository<AuditEvent>,
    agent: LcpAgent,
    role: LcpRole,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await auditRepo.save(
      auditRepo.create({
        companyId: agent.companyId,
        role: role.name,
        agentId: agent.id,
        eventType: AuditEventType.Decision,
        payload,
      }),
    );
  }
}
