import { HumanMessage } from '@langchain/core/messages';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import { MessagesAnnotation } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import {
  AgentStatus,
  AuditClientService,
  AuditEventType,
  classifyRateLimit,
  ContextManagerService,
  DEFAULT_LLM_CONTEXT_WINDOW,
  DEFAULT_REQUIRED_TOOL_RETRIES,
  LlmIdentity,
  TcpAgent,
  SupervisedGraphResult,
} from '@tcp/shared';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { UUID } from 'crypto';
import { Repository } from 'typeorm';
import { InitialStateService } from './initial-state.service';
import {
  AgentLoopTracker,
  baseToolName,
  buildCompletionSummary,
  createTracker,
} from './loop-tracker';
import {
  buildRequiredToolReminder,
  resolveRequiredTools,
} from './required-tools';
import {
  AgentRunEnvironmentService,
  RunLimits,
  resolveRunLimits,
} from './run-environment.service';
import {
  AgentRunStatusService,
  describeRunFailure,
  describeAbort,
} from './run-status.service';
import { SpendGateService } from './spend-gate.service';
import {
  SupervisedRunContext,
  SupervisedTurnService,
} from './supervised-turn.service';

/**
 * Log lines for each terminal outcome in {@link AgentLoopService.settleRunResult},
 * so the main run and the required-tool reminder can narrate themselves
 * differently while sharing one ladder.
 */
interface TerminalLogMessages {
  paused: string;
  completed: string;
  cancelled: string;
}

/** The trimmed text of an AI message's content, or `''` when it carried none. */
function trimmedText(raw: unknown): string {
  return (typeof raw === 'string' ? raw : '').trim();
}

/**
 * Executes and manages the LangGraph agent loop for a single {@link TcpAgent} run.
 *
 * Each call to {@link AgentLoopService.run} corresponds to one BullMQ job.
 * State is persisted to PostgreSQL via the LangGraph checkpoint store so that
 * the agent can be resumed after an interruption. The run's tool/model envelope
 * comes from {@link AgentRunEnvironmentService}, its opening prompt from
 * {@link InitialStateService}, and its status writes go through
 * {@link AgentRunStatusService}.
 *
 * Resource limits — resolved at run-time in precedence order:
 * 1. `TcpRole.runConfig` → 2. `TcpCompany.runConfig` → 3. env vars
 *    (`AGENT_ITERATIONS`, `AGENT_LOOP_TIMEOUT_MS`) → 4. code defaults
 *    ({@link DEFAULT_AGENT_ITERATIONS}, {@link DEFAULT_AGENT_LOOP_TIMEOUT_MS})
 *
 * **Pause/resume flow:**
 *
 * When an agent calls `request_user_input` or `request_agent_consultation` via
 * the interactions MCP server, tcp-server sets the agent's status to
 * {@link AgentStatus.Paused}. `runSupervisedGraph` (see {@link SupervisedTurnService})
 * re-reads the agent status between tool-loop iterations; detecting Paused
 * causes an early exit so the BullMQ job completes normally without marking
 * the agent failed. On resume, tcp-server enqueues a new job with
 * `replyContent` which is injected as the first HumanMessage into the
 * resumed LangGraph stream.
 */
@Injectable()
export class AgentLoopService {
  private readonly logger = new Logger(AgentLoopService.name);
  private readonly databaseUrl: string;

  constructor(
    private readonly config: ConfigService,
    private readonly auditClient: AuditClientService,
    private readonly contextManager: ContextManagerService,
    private readonly environment: AgentRunEnvironmentService,
    private readonly initialState: InitialStateService,
    private readonly status: AgentRunStatusService,
    private readonly turns: SupervisedTurnService,
    private readonly spendGate: SpendGateService,
    @InjectRepository(TcpAgent)
    private readonly agentRepo: Repository<TcpAgent>,
  ) {
    this.databaseUrl = this.config.getOrThrow<string>('DATABASE_URL');
  }

  /**
   * Runs (or resumes) the agent loop for the given agent.
   *
   * @param replyContent - When provided, the agent is resuming from a pause.
   *   The content is injected as the first HumanMessage instead of rebuilding
   *   the full initial-state prompt from scratch.
   * @param abortController - Owned by the caller ({@link AgentWorkerService}),
   *   which registers it in {@link AgentRegistryService} *before* calling this
   *   method — synchronously, with no `await` in between, so the duplicate-job
   *   check and the registration are atomic. Registering here instead (after
   *   the `agentRepo.findOne` below) would reopen that race: a stalled-job
   *   retry dispatched while this call is still awaiting that query would see
   *   `isRunning() === false` and start a second, concurrent execution against
   *   the same LangGraph checkpoint thread.
   */
  async run(
    agentId: UUID,
    replyContent: string | undefined,
    abortController: AbortController,
  ): Promise<void> {
    const agent = await this.agentRepo.findOne({
      where: { id: agentId },
      // The assignment (and its task) drive prompt part 4 — see InitialStateService.
      relations: { role: true, company: true, assignment: { task: true } },
    });
    if (!agent) {
      this.logger.error(`Agent ${agentId} not found — skipping job`);
      return;
    }

    const limits = resolveRunLimits(agent, this.config);
    if (!limits) {
      await this.status.failRun(
        agent,
        'No LLM config: role has no llmConfig, company has no llmConfig, and no LLM env fallback is configured',
      );
      return;
    }

    /** Cancels the run after the resolved wall-clock timeout. */
    const timeoutId = setTimeout(
      () => abortController.abort('timeout'),
      limits.timeoutMs,
    );

    await this.status.updateStatus(agent, AgentStatus.Running, agentId);

    const checkpointer = PostgresSaver.fromConnString(this.databaseUrl);
    try {
      await checkpointer.setup();
      await this.runLoop(
        agent,
        limits,
        checkpointer,
        abortController,
        replyContent,
      );
    } catch (err) {
      // runLoop handles its own errors; this covers checkpointer.setup() and
      // anything else escaping, which would otherwise leave the agent stuck
      // Running (and any pending consultation unresolved forever).
      //
      // A rate limit here (the pre-turn compaction call) pauses only a
      // resume: a first run hasn't checkpointed yet, and a resume of it
      // would carry a continuation prompt with nothing to continue.
      const limit =
        replyContent !== undefined
          ? classifyRateLimit(err, limits.llmConfig.provider)
          : undefined;
      if (limit) {
        await this.status.pauseForRateLimit(agent, limit, false);
        return;
      }
      await this.status.failRun(
        agent,
        describeRunFailure(err, abortController, limits.timeoutMs),
      );
    } finally {
      clearTimeout(timeoutId);
      await checkpointer.end();
    }
  }

  /**
   * Prepares a single agent run or resume within an established resource
   * envelope (checkpointer, abort signal): assembles the toolset, budget-checks
   * and builds the opening input (resume path vs. full initial-state build),
   * then hands it to {@link driveToTerminal}.
   */
  private async runLoop(
    agent: TcpAgent,
    limits: RunLimits,
    checkpointer: PostgresSaver,
    abortController: AbortController,
    replyContent?: string,
  ): Promise<void> {
    const env = await this.environment.assemble(
      agent,
      limits.llmConfig,
      checkpointer,
      abortController,
    );
    const config = {
      configurable: { thread_id: agent.id },
      signal: abortController.signal,
    };
    // Resolved once per run — attributes this run's token usage (LLM audit
    // rows and any compaction call) to the provider/model actually invoked.
    const llm: LlmIdentity = {
      provider: limits.llmConfig.provider,
      model: limits.llmConfig.model,
    };

    // Check context budget and compact if needed before invoking — same
    // protection chat.service.ts's inline turns already have (see
    // ContextManagerService), now also covering worker runs (fresh, resumed,
    // and consulted-agent runs), which previously had none at all.
    const windowSize =
      Number(limits.llmConfig.contextWindow) || DEFAULT_LLM_CONTEXT_WINDOW;
    const isFirstMessage = replyContent === undefined;
    const { message: preparedMessage } = await this.contextManager.prepare(
      agent.id,
      replyContent ?? agent.initialPrompt,
      env.model,
      windowSize,
      env.graph,
      config,
      isFirstMessage,
      agent,
      agent.role,
      env.langchainTools,
      llm,
    );

    // Resume path: inject reply as the next message; checkpoint holds prior state
    const input: typeof MessagesAnnotation.State = !isFirstMessage
      ? { messages: [new HumanMessage(preparedMessage)] }
      : await this.initialState.build(
          agent,
          env.mcpTools,
          env.mcpServerUrls,
          preparedMessage,
          env.hasKnowledge,
        );

    const tracker = createTracker();
    const ctx: SupervisedRunContext = {
      agent,
      model: env.model,
      allTools: env.langchainTools,
      graph: env.graph,
      config,
      windowSize,
      abortController,
      maxIterations: limits.maxIterations,
      timeoutMs: limits.timeoutMs,
      buildGraph: env.buildGraph,
      llm,
      holdSpending: this.spendGate.forRun(agent, llm.provider, isFirstMessage),
    };

    await this.driveToTerminal(ctx, input, tracker, env.langchainTools);
  }

  /**
   * Runs turns until the agent reaches a terminal status: the opening turn,
   * then — if it ended without one — either the required-tool reminder ladder
   * or the narrated-text fallback. Any error escaping fails the run, except
   * a provider's rate limit, which pauses it.
   */
  private async driveToTerminal(
    ctx: SupervisedRunContext,
    input: typeof MessagesAnnotation.State,
    tracker: AgentLoopTracker,
    tools: DynamicStructuredTool[],
  ): Promise<void> {
    const { agent } = ctx;
    try {
      const result = await this.turns.run(ctx, input, tracker);

      if (
        await this.settleRunResult(agent, ctx, result, tracker, {
          paused: `Agent ${agent.id} loop ending with status 'paused' (set by tool call)`,
          completed: `Agent ${agent.id} loop ending with status 'completed' (set by tool call)`,
          // Task cancellation already set this status (and recorded the audit
          // event) — just stop the loop, no further writes.
          cancelled: `Agent ${agent.id} loop ending: task cancelled`,
        })
      ) {
        return;
      }

      // The stream ended without the agent reaching a terminal status. Agents
      // with required tool calls (default: complete_assignment) are reminded and
      // re-streamed instead of falling back to narrated text — a narrated
      // "completion" would never resolve a pending consultation.
      const requiredTools = resolveRequiredTools(agent, tools, this.logger);
      if (requiredTools.length > 0) {
        await this.enforceRequiredTools(ctx, tracker, requiredTools, tools);
        return;
      }

      await this.completeFromNarration(ctx, tracker, result);
    } catch (err) {
      // A provider refusing the call is a pause, not a failure: the run
      // resumes from its checkpoint once the provider allows it.
      const limit = classifyRateLimit(err, ctx.llm.provider);
      if (limit) {
        const progressed =
          tracker.lastResponseText !== '' || tracker.actions.length > 0;
        await this.status.pauseForRateLimit(agent, limit, progressed);
        return;
      }
      const msg = describeRunFailure(err, ctx.abortController, ctx.timeoutMs);
      this.logger.error(`Agent ${agent.id} loop error: ${msg}`);
      await this.status.failRun(agent, msg);
    }
  }

  /**
   * Reminds the agent to make its outstanding required tool calls, re-running
   * the stream up to `AGENT_REQUIRED_TOOL_RETRIES` times. Each round re-reads
   * the agent status: Completed takes the normal summary/publish path, Paused
   * exits cleanly. If the retries are exhausted the run is failed — narrated
   * text is never accepted in place of the required calls.
   */
  private async enforceRequiredTools(
    ctx: SupervisedRunContext,
    tracker: AgentLoopTracker,
    requiredTools: string[],
    tools: { name: string }[],
  ): Promise<void> {
    const retries =
      this.config.get<number>('AGENT_REQUIRED_TOOL_RETRIES') ??
      DEFAULT_REQUIRED_TOOL_RETRIES;
    const { agent } = ctx;

    // Name tools in reminders exactly as the LLM sees them (server-prefixed).
    const callableName = (base: string): string =>
      tools.find((t) => baseToolName(t.name) === base)?.name ?? base;

    for (let attempt = 1; attempt <= retries; attempt++) {
      const nudge = buildRequiredToolReminder(
        requiredTools,
        tracker,
        callableName,
      );
      this.logger.warn(
        `Agent ${agent.id} ended without required tool call(s) [${requiredTools.join(', ')}] — reminder ${attempt}/${retries}`,
      );

      const result = await this.turns.run(
        ctx,
        { messages: [new HumanMessage(nudge)] },
        tracker,
      );

      if (
        await this.settleRunResult(agent, ctx, result, tracker, {
          paused: `Agent ${agent.id} paused during required-tool reminder — exiting`,
          completed: `Agent ${agent.id} completed after required-tool reminder ${attempt}`,
          cancelled: `Agent ${agent.id} loop ending during required-tool reminder: task cancelled`,
        })
      ) {
        return;
      }
    }

    await this.status.failRun(
      agent,
      `Agent ended without successfully calling required tool(s): ${requiredTools.join(', ')} after ${retries} reminder(s)`,
    );
  }

  /**
   * The no-required-tools ending: accept the model's narrated text as the run's
   * output, after one retry if the first turn produced nothing at all.
   */
  private async completeFromNarration(
    ctx: SupervisedRunContext,
    tracker: AgentLoopTracker,
    result: SupervisedGraphResult,
  ): Promise<void> {
    const { agent } = ctx;
    let content = trimmedText(result.lastAiMessage?.content);
    if (!content) {
      // One retry: ask the agent to continue with an explicit continuation prompt
      this.logger.warn(`Agent ${agent.id} produced empty output — retrying`);
      const retryResult = await this.turns.run(
        ctx,
        { messages: [new HumanMessage('Please provide your response.')] },
        tracker,
      );
      content = trimmedText(retryResult.lastAiMessage?.content);
    }

    if (!content) {
      await this.status.failRun(agent, 'LLM produced no output after retry');
      return;
    }

    // Fallback completion — notifyComplete is idempotent if complete_assignment was called.
    // Write output directly first so tcp-server's recovery/replay path can read
    // it (the completed event originates there); notifyComplete may lag.
    await this.agentRepo.update(agent.id, { output: content });
    this.auditClient.notifyComplete(agent.id, content);
    await this.status.updateStatus(agent, AgentStatus.Completed);
  }

  /**
   * Applies the terminal outcome of one supervised run: fails the run if it
   * was aborted, records the completion summary if it completed, and logs the
   * caller's wording otherwise.
   *
   * Both the main run and each required-tool reminder settle their result
   * here, so a newly terminal {@link AgentStatus} only has to be handled once.
   *
   * @returns `true` when the run reached a terminal state and the loop should
   *   stop; `false` when it ended without one and the caller should continue.
   */
  private async settleRunResult(
    agent: TcpAgent,
    ctx: SupervisedRunContext,
    result: SupervisedGraphResult,
    tracker: AgentLoopTracker,
    messages: TerminalLogMessages,
  ): Promise<boolean> {
    if (result.aborted) {
      await this.status.failRun(
        agent,
        result.failureReason ??
          describeAbort(ctx.abortController, ctx.timeoutMs),
      );
      return true;
    }

    switch (result.terminalStatus) {
      case AgentStatus.Paused:
        this.logger.log(messages.paused);
        return true;
      case AgentStatus.Completed:
        this.logger.log(messages.completed);
        this.auditClient.record(
          agent.companyId,
          agent.role.name,
          agent.id,
          AuditEventType.AgentLoopCompletion,
          buildCompletionSummary(tracker),
        );
        return true;
      case AgentStatus.Cancelled:
        this.logger.log(messages.cancelled);
        return true;
      default:
        return false;
    }
  }
}
