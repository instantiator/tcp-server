import type { DynamicStructuredTool } from '@langchain/core/tools';
import { MessagesAnnotation } from '@langchain/langgraph';
import {
  AgentStatus,
  ContextManagerService,
  LlmConfig,
  LlmIdentity,
  SupervisedGraphResult,
  TcpAgent,
  buildAgentGraph,
  buildChatModel,
  runSupervisedGraph,
} from '@tcp/shared';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentLoopEventRecorder } from './loop-events.service';
import { AgentLoopTracker } from './loop-tracker';

/**
 * Bundles the per-run values a supervised turn needs, shared across the main
 * run, the empty-output retry, and each required-tool reminder.
 */
export interface SupervisedRunContext {
  agent: TcpAgent;
  model: ReturnType<typeof buildChatModel>;
  allTools: DynamicStructuredTool[];
  /**
   * The graph built once in {@link AgentRunEnvironmentService.assemble} (and
   * already used for the pre-turn `ContextManagerService.prepare` check) —
   * reused as `initialGraph` by every turn of this job.
   */
  graph: ReturnType<typeof buildAgentGraph>;
  config: { configurable: { thread_id: string }; signal: AbortSignal };
  windowSize: number;
  abortController: AbortController;
  maxIterations: number;
  /** The run's wall-clock timeout — used to build a human-readable reason if it fires. */
  timeoutMs: number;
  buildGraph: (
    tools: DynamicStructuredTool[],
  ) => ReturnType<typeof buildAgentGraph>;
  /** The run's resolved provider/model, for attributing recorded token usage. */
  llm: LlmIdentity;
  /** The run's LLM config, to name the provider in a failure message. */
  llmConfig: LlmConfig;
  /** Asked before every LLM call; true means a spend cap has paused the agent. */
  holdSpending: () => Promise<boolean>;
}

/**
 * Runs one turn of the shared {@link runSupervisedGraph} with tcp-agent's own
 * hooks bound in: the observability recorder, and a DB-backed terminal-status
 * check so a pause/complete/cancel written by another service stops the loop
 * between iterations.
 */
@Injectable()
export class SupervisedTurnService {
  constructor(
    private readonly contextManager: ContextManagerService,
    private readonly recorder: AgentLoopEventRecorder,
    @InjectRepository(TcpAgent)
    private readonly agentRepo: Repository<TcpAgent>,
  ) {}

  /** Streams one turn to completion, returning how it ended. */
  run(
    ctx: SupervisedRunContext,
    input: typeof MessagesAnnotation.State,
    tracker: AgentLoopTracker,
  ): Promise<SupervisedGraphResult> {
    return runSupervisedGraph({
      agentId: ctx.agent.id,
      agent: ctx.agent,
      role: ctx.agent.role,
      model: ctx.model,
      allTools: ctx.allTools,
      initialGraph: ctx.graph,
      input,
      config: ctx.config,
      contextManager: this.contextManager,
      windowSize: ctx.windowSize,
      abortController: ctx.abortController,
      llm: ctx.llm,
      hooks: {
        buildGraph: ctx.buildGraph,
        onEvent: this.recorder.forTurn(
          ctx.agent,
          tracker,
          ctx.llm,
          ctx.abortController,
        ),
        checkTerminalStatus: async () => {
          const fresh = await this.agentRepo.findOneBy({ id: ctx.agent.id });
          return fresh?.status === AgentStatus.Paused ||
            fresh?.status === AgentStatus.Completed ||
            fresh?.status === AgentStatus.Cancelled
            ? fresh.status
            : null;
        },
        maxIterations: ctx.maxIterations,
        holdSpending: ctx.holdSpending,
      },
    });
  }
}
