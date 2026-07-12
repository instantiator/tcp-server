import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import { MessagesAnnotation } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import {
  AgentLoopCompletionSummary,
  AgentStatus,
  AuditClientService,
  AuditEventType,
  ContextManagerService,
  DEFAULT_AGENT_ITERATIONS,
  DEFAULT_AGENT_LOOP_TIMEOUT_MS,
  DEFAULT_LLM_CONTEXT_WINDOW,
  DEFAULT_REQUIRED_TOOL_RETRIES,
  LcpAgent,
  LlmConfig,
  StreamEventLike,
  SupervisedGraphResult,
  ToolVisibilityTracker,
  buildAgentGraph,
  mapStreamEvent,
  renderTemplate,
  resolveEnvLlmConfig,
  resolveLlmConfig,
  resolveMcpServerList,
  resolveRunConfig,
  runSupervisedGraph,
} from '@lcp/shared';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { UUID } from 'crypto';
import { Repository } from 'typeorm';
import { agentPrompts } from '../agent-prompts';
import { buildChatModel } from '../llm/llm-factory';
import { McpClientService } from '../mcp/mcp-client.service';
import { resolveMcpServerUrls } from '../mcp/mcp-registry';
import { AgentRagService } from '../rag/agent-rag.service';
import { StorageTrackingClientService } from '../storage-tracking/storage-tracking-client.service';
import { AgentEventPublisherService } from './agent-event-publisher.service';
import {
  AgentLoopTracker,
  applyStorageResult,
  baseToolName,
  createTracker,
  generateActionString,
} from './loop-tracker';
import {
  buildAssignmentMessage,
  buildRagMessage,
  buildServicesMessage,
  renderSystemPrompt,
} from './prompt-assembly';

/** Maps LangGraph v2 event names to {@link AuditEventType} values. */
const EVENT_TYPE_MAP: Record<string, AuditEventType> = {
  on_chat_model_start: AuditEventType.LlmRequest,
  on_chat_model_end: AuditEventType.LlmResponse,
  on_tool_start: AuditEventType.ToolCall,
  on_tool_end: AuditEventType.ToolResult,
};

/**
 * Bundles the per-run values {@link AgentLoopService.runSupervised} needs,
 * shared across the main run, the empty-output retry, and each
 * required-tool reminder in {@link AgentLoopService.enforceRequiredTools}.
 */
interface SupervisedRunContext {
  agent: LcpAgent;
  model: ReturnType<typeof buildChatModel>;
  allTools: DynamicStructuredTool[];
  /**
   * The graph built once in {@link AgentLoopService.runLoop} (and already
   * used for the pre-turn `ContextManagerService.prepare` check) — reused as
   * `initialGraph` by every {@link AgentLoopService.runSupervised} call for
   * this job (main run, empty-output retry, required-tool reminders), same
   * as the single shared graph the old `streamAndAudit` call sites reused.
   */
  graph: ReturnType<typeof buildAgentGraph>;
  config: { configurable: { thread_id: string }; signal: AbortSignal };
  windowSize: number;
  abortController: AbortController;
  maxIterations: number;
  buildGraph: (
    tools: DynamicStructuredTool[],
  ) => ReturnType<typeof buildAgentGraph>;
  /** Shared across every {@link AgentLoopService.runSupervised} call for this
   * job, so a server described during the main run stays visible through a
   * subsequent retry or required-tool reminder. */
  toolVisibility: ToolVisibilityTracker;
}

/**
 * Executes and manages the LangGraph agent loop for a single {@link LcpAgent} run.
 *
 * Each call to {@link AgentLoopService.run} corresponds to one BullMQ job.
 * State is persisted to PostgreSQL via the LangGraph checkpoint store so that
 * the agent can be resumed after an interruption.
 *
 * Resource limits — resolved at run-time in precedence order:
 * 1. `LcpRole.runConfig` → 2. `LcpCompany.runConfig` → 3. env vars
 *    (`AGENT_ITERATIONS`, `AGENT_LOOP_TIMEOUT_MS`) → 4. code defaults
 *    ({@link DEFAULT_AGENT_ITERATIONS}, {@link DEFAULT_AGENT_LOOP_TIMEOUT_MS})
 *
 * **Pause/resume flow:**
 *
 * When an agent calls `request_user_input` or `request_agent_consultation` via
 * the interactions MCP server, lcp-server sets the agent's status to
 * {@link AgentStatus.Paused}. `runSupervisedGraph` (see {@link runSupervised})
 * re-reads the agent status between tool-loop iterations; detecting Paused
 * causes an early exit so the BullMQ job completes normally without marking
 * the agent failed. On resume, lcp-server enqueues a new job with
 * `replyContent` which is injected as the first HumanMessage into the
 * resumed LangGraph stream.
 */
@Injectable()
export class AgentLoopService {
  private readonly logger = new Logger(AgentLoopService.name);
  private readonly databaseUrl: string;

  constructor(
    private readonly rag: AgentRagService,
    private readonly mcp: McpClientService,
    private readonly config: ConfigService,
    private readonly auditClient: AuditClientService,
    private readonly storageTracking: StorageTrackingClientService,
    private readonly events: AgentEventPublisherService,
    private readonly contextManager: ContextManagerService,
    @InjectRepository(LcpAgent)
    private readonly agentRepo: Repository<LcpAgent>,
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
      // The assignment (and its task) drive prompt part 4 — see buildInitialState.
      relations: { role: true, company: true, assignment: { task: true } },
    });
    if (!agent) {
      this.logger.error(`Agent ${agentId} not found — skipping job`);
      return;
    }

    const llmConfig = resolveLlmConfig(
      agent.role,
      agent.company,
      resolveEnvLlmConfig(this.config),
    );

    if (!llmConfig) {
      await this.failRun(
        agent,
        'No LLM config: role has no llmConfig, company has no llmConfig, and no LLM env fallback is configured',
      );
      return;
    }

    const maxIterations = resolveRunConfig(
      'maxIterations',
      agent.role,
      agent.company,
      this.config.get<number>('AGENT_ITERATIONS'),
      DEFAULT_AGENT_ITERATIONS,
    );
    const timeoutMs = resolveRunConfig(
      'timeoutMs',
      agent.role,
      agent.company,
      this.config.get<number>('AGENT_LOOP_TIMEOUT_MS'),
      DEFAULT_AGENT_LOOP_TIMEOUT_MS,
    );

    /** Cancels the run after the resolved wall-clock timeout. */
    const timeoutId = setTimeout(
      () => abortController.abort('timeout'),
      timeoutMs,
    );

    await this.updateStatus(agent, AgentStatus.Running, agentId);

    const checkpointer = PostgresSaver.fromConnString(this.databaseUrl);
    try {
      await checkpointer.setup();
      await this.runLoop(
        agent,
        llmConfig,
        checkpointer,
        abortController,
        maxIterations,
        replyContent,
      );
    } catch (err) {
      // runLoop handles its own errors; this covers checkpointer.setup() and
      // anything else escaping, which would otherwise leave the agent stuck
      // Running (and any pending consultation unresolved forever).
      const msg = err instanceof Error ? err.message : String(err);
      await this.failRun(agent, msg);
    } finally {
      clearTimeout(timeoutId);
      await checkpointer.end();
    }
  }

  /**
   * Orchestrates a single agent run or resume within an established resource
   * envelope (checkpointer, abort signal).
   *
   * Loads MCP tools from the role's permitted server list, builds the LangGraph
   * graph, constructs the input state (resume path vs. full initial-state build),
   * then delegates to {@link runSupervisedGraph}. Handles post-stream status
   * resolution: paused (early exit), completed (generate summary), or
   * fallback completion when the loop ends without an explicit tool call.
   */
  private async runLoop(
    agent: LcpAgent,
    llmConfig: LlmConfig,
    checkpointer: PostgresSaver,
    abortController: AbortController,
    maxIterations: number,
    replyContent?: string,
  ): Promise<void> {
    const mcpServerUrls = resolveMcpServerUrls(this.config);
    // Additive union: default registry servers, plus any extras from the
    // company and the role (not a precedence chain — every source contributes).
    const mcpServerNames = resolveMcpServerList(
      Object.keys(mcpServerUrls),
      agent.company,
      agent.role,
    );
    const mcpTools = await this.mcp.loadTools(mcpServerNames, mcpServerUrls, {
      agentId: agent.id,
      companyId: agent.companyId,
    });
    const langchainTools = mcpTools.map((t) => t.tool);

    const model = buildChatModel(llmConfig);
    const buildGraph = (tools: DynamicStructuredTool[]) =>
      buildAgentGraph({
        model,
        checkpointer,
        tools,
        logger: this.logger,
        interruptAfterTools: true,
        signal: abortController.signal,
      });
    // Tool-schema gating: only each server's describe_server tool (plus
    // always-visible servers, e.g. interactions) is bound until the agent
    // describes it — the initial graph and budget check below must use this
    // same gated set, not the full one, or the very first turn would bind
    // everything regardless.
    const toolVisibility = new ToolVisibilityTracker();
    const initialTools = toolVisibility.resolveVisibleTools(langchainTools);
    const graph = buildGraph(initialTools);

    const config = {
      configurable: { thread_id: agent.id },
      signal: abortController.signal,
    };

    // Check context budget and compact if needed before invoking — same
    // protection chat.service.ts's inline turns already have (see
    // ContextManagerService), now also covering worker runs (fresh, resumed,
    // and consulted-agent runs), which previously had none at all.
    const windowSize =
      Number(llmConfig.contextWindow) || DEFAULT_LLM_CONTEXT_WINDOW;
    const isFirstMessage = replyContent === undefined;
    const { message: preparedMessage } = await this.contextManager.prepare(
      agent.id,
      replyContent ?? agent.initialPrompt,
      model,
      windowSize,
      graph,
      config,
      isFirstMessage,
      agent,
      agent.role,
      initialTools,
    );

    // Resume path: inject reply as the next message; checkpoint holds prior state
    const input: typeof MessagesAnnotation.State = !isFirstMessage
      ? { messages: [new HumanMessage(preparedMessage)] }
      : await this.buildInitialState(
          agent,
          mcpTools,
          mcpServerUrls,
          preparedMessage,
        );

    const tracker = createTracker();
    const ctx: SupervisedRunContext = {
      agent,
      model,
      allTools: langchainTools,
      graph,
      config,
      windowSize,
      abortController,
      maxIterations,
      buildGraph,
      toolVisibility,
    };

    try {
      const result = await this.runSupervised(ctx, input, tracker);

      if (result.aborted) {
        await this.failRun(
          agent,
          result.failureReason ??
            String(abortController.signal.reason ?? 'unknown'),
        );
        return;
      }

      if (result.terminalStatus === AgentStatus.Paused) {
        this.logger.log(
          `Agent ${agent.id} loop ending with status 'paused' (set by tool call)`,
        );
        return;
      }
      if (result.terminalStatus === AgentStatus.Completed) {
        this.logger.log(
          `Agent ${agent.id} loop ending with status 'completed' (set by tool call)`,
        );
        this.recordCompletionSummary(agent, tracker);
        return;
      }

      // The stream ended without the agent reaching a terminal status. Agents
      // with required tool calls (default: complete_assignment) are reminded and
      // re-streamed instead of falling back to narrated text — a narrated
      // "completion" would never resolve a pending consultation.
      const requiredTools = this.resolveRequiredTools(agent, langchainTools);
      if (requiredTools.length > 0) {
        await this.enforceRequiredTools(
          ctx,
          tracker,
          requiredTools,
          langchainTools,
        );
        return;
      }

      const rawContent = result.lastAiMessage?.content;
      let content = (typeof rawContent === 'string' ? rawContent : '').trim();
      if (!content) {
        // One retry: ask the agent to continue with an explicit continuation prompt
        this.logger.warn(`Agent ${agent.id} produced empty output — retrying`);
        const retryResult = await this.runSupervised(
          ctx,
          { messages: [new HumanMessage('Please provide your response.')] },
          tracker,
        );
        const rawRetryContent = retryResult.lastAiMessage?.content;
        content = (
          typeof rawRetryContent === 'string' ? rawRetryContent : ''
        ).trim();
      }

      if (!content) {
        await this.failRun(agent, 'LLM produced no output after retry');
        return;
      }

      // Fallback completion — notifyComplete is idempotent if complete_assignment was called.
      // Write output directly first so lcp-server's recovery/replay path can read
      // it (the completed event originates there); notifyComplete may lag.
      await this.agentRepo.update(agent.id, { output: content });
      this.auditClient.notifyComplete(agent.id, content);
      await this.updateStatus(agent, AgentStatus.Completed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Agent ${agent.id} loop error: ${msg}`);
      await this.failRun(agent, msg);
    }
  }

  /**
   * Runs one supervised turn (see {@link runSupervisedGraph}) with this
   * service's audit/tracker/observability side effects wired up via
   * {@link buildOnEvent} and DB-backed terminal-status/iteration hooks.
   */
  private async runSupervised(
    ctx: SupervisedRunContext,
    input: typeof MessagesAnnotation.State,
    tracker: AgentLoopTracker,
  ): Promise<SupervisedGraphResult> {
    const onEvent = this.buildOnEvent(ctx.agent, tracker);
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
      hooks: {
        buildGraph: ctx.buildGraph,
        onEvent: (event) => {
          ctx.toolVisibility.onEvent(event);
          onEvent(event);
        },
        checkTerminalStatus: async () => {
          const fresh = await this.agentRepo.findOneBy({ id: ctx.agent.id });
          return fresh?.status === AgentStatus.Paused ||
            fresh?.status === AgentStatus.Completed
            ? fresh.status
            : null;
        },
        maxIterations: ctx.maxIterations,
        resolveVisibleTools: (tools) =>
          ctx.toolVisibility.resolveVisibleTools(tools),
      },
    });
  }

  /**
   * Builds a per-run `onEvent` handler: writes audit rows, tracks tool
   * actions/storage changes, and relays every event to observing SSE
   * clients. `pendingToolInputs` correlates `on_tool_start` inputs to
   * `on_tool_end` outputs by `run_id` — scoped to one {@link runSupervised}
   * call, matching the previous per-call `streamAndAudit` scoping.
   */
  private buildOnEvent(
    agent: LcpAgent,
    tracker: AgentLoopTracker,
  ): (event: StreamEventLike) => void {
    // ponytail: actions include failed tool calls; on_tool_start used for simplicity
    const pendingToolInputs = new Map<string, Record<string, unknown>>();

    return (event: StreamEventLike) => {
      const auditType = EVENT_TYPE_MAP[event.event];
      if (auditType) {
        this.auditClient.record(
          agent.companyId,
          agent.role.name,
          agent.id,
          auditType,
          event.data ?? {},
        );
      }

      // Relay the same stream events to observing SSE clients (LLM activity,
      // reasoning/response token deltas). No-op when Redis is not configured.
      for (const observabilityEvent of mapStreamEvent(event)) {
        this.events.publish(agent.id, observabilityEvent);
      }

      if (event.event === 'on_tool_start') {
        const input_ = event.data?.input ?? {};
        const runId = event.run_id ?? '';
        pendingToolInputs.set(runId, input_);
        tracker.actions.push(generateActionString(event.name ?? '', input_));
        tracker.firedTools.add(baseToolName(event.name ?? ''));
      }

      if (event.event === 'on_tool_end') {
        const runId = event.run_id ?? '';
        const toolInput = pendingToolInputs.get(runId) ?? {};
        const output = event.data?.output;
        applyStorageResult(event.name ?? '', toolInput, output, tracker);
        pendingToolInputs.delete(runId);
        this.storageTracking.patch(agent.id, tracker.storage);
      }
    };
  }

  /**
   * Resolves the tool calls this agent must make before its run may end.
   * Null on the agent means the default (`complete_assignment`); an empty array
   * opts out. Required tools missing from the loaded toolset are dropped
   * with a warning — a role without the relevant MCP server must not fail
   * every run inevitably.
   */
  private resolveRequiredTools(
    agent: LcpAgent,
    tools: { name: string }[],
  ): string[] {
    const required = agent.requiredToolCalls ?? ['complete_assignment'];
    const available = new Set(tools.map((t) => baseToolName(t.name)));
    return required.filter((toolName) => {
      if (available.has(toolName)) return true;
      this.logger.warn(
        `Agent ${agent.id} requires tool '${toolName}' but it is not in the loaded toolset — skipping enforcement for it`,
      );
      return false;
    });
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
      // Distinguish "never called" from "called but the call did not succeed"
      // (the tool fired yet the status never flipped, e.g. complete_assignment errored).
      const missing = requiredTools.filter((t) => !tracker.firedTools.has(t));
      const nudge = missing.length
        ? renderTemplate(agentPrompts.required_tools_reminder, {
            tools: missing.map(callableName).join(', '),
          })
        : renderTemplate(agentPrompts.required_tools_call_failed, {
            tools: requiredTools.map(callableName).join(', '),
          });
      this.logger.warn(
        `Agent ${agent.id} ended without required tool call(s) [${requiredTools.join(', ')}] — reminder ${attempt}/${retries}`,
      );

      const result = await this.runSupervised(
        ctx,
        { messages: [new HumanMessage(nudge)] },
        tracker,
      );

      if (result.aborted) {
        await this.failRun(
          agent,
          result.failureReason ??
            String(ctx.abortController.signal.reason ?? 'unknown'),
        );
        return;
      }

      if (result.terminalStatus === AgentStatus.Paused) {
        this.logger.log(
          `Agent ${agent.id} paused during required-tool reminder — exiting`,
        );
        return;
      }
      if (result.terminalStatus === AgentStatus.Completed) {
        this.logger.log(
          `Agent ${agent.id} completed after required-tool reminder ${attempt}`,
        );
        this.recordCompletionSummary(agent, tracker);
        return;
      }
    }

    await this.failRun(
      agent,
      `Agent ended without successfully calling required tool(s): ${requiredTools.join(', ')} after ${retries} reminder(s)`,
    );
  }

  /**
   * Marks the run as failed: records the state change, sets the agent status,
   * and notifies lcp-server (which resolves any pending consultation as failed,
   * resumes the calling agent, and emits the terminal `failed` event to any SSE
   * clients observing this agent).
   *
   * No-op if the agent has already reached Completed — `complete_assignment` may
   * have won the race against a late failure (e.g. a summary error).
   */
  private async failRun(agent: LcpAgent, reason: string): Promise<void> {
    const fresh = await this.agentRepo.findOneBy({ id: agent.id });
    if (fresh?.status === AgentStatus.Completed) {
      this.logger.warn(
        `Agent ${agent.id} already completed — ignoring failure: ${reason}`,
      );
      return;
    }
    this.logger.error(`Agent ${agent.id} run failed: ${reason}`);
    this.recordStateChange(agent, 'failed', reason);
    await this.updateStatus(agent, AgentStatus.Failed);
    this.auditClient.notifyFailed(agent.id, reason);
  }

  /**
   * Builds the full initial-state message list for the first run of an agent.
   *
   * @param initialPrompt - The task prompt to use for prompt part 4, already
   *   passed through {@link ContextManagerService.prepare} (may differ from
   *   `agent.initialPrompt` if the incoming-data guard compacted it).
   */
  private async buildInitialState(
    agent: LcpAgent,
    mcpTools: Awaited<ReturnType<McpClientService['loadTools']>>,
    mcpServerUrls: Record<string, string>,
    initialPrompt: string,
  ): Promise<typeof MessagesAnnotation.State> {
    const { role, company, assignment } = agent;
    const systemPrompt = renderSystemPrompt(agent, role, company);

    const ragChunks = await this.rag.retrieve(
      role.id,
      company.id,
      initialPrompt,
      company.embeddingConfig,
    );
    const ragMessage = ragChunks.length
      ? new HumanMessage(buildRagMessage(ragChunks))
      : null;

    const loadedServerNames = [...new Set(mcpTools.map((t) => t.serverName))];
    const servicesText = buildServicesMessage(loadedServerNames, mcpServerUrls);
    const servicesMessage = servicesText
      ? new HumanMessage(servicesText)
      : null;

    // Prompt part 4: assignment presentation — the mode prompt plus the
    // assignment prompt (already context-prepared as `initialPrompt`) and any
    // materials/expected outputs. Replaces the old bare initial-prompt message.
    const assignmentMessage = new HumanMessage(
      buildAssignmentMessage({
        mode: assignment.mode,
        prompt: initialPrompt,
        materials: assignment.materials,
        expected: assignment.expected,
        resolutionContext: {
          companySlug: company.slug,
          task: assignment.task ?? null,
          assignment: {
            id: assignment.id,
            taskId: assignment.taskId ?? null,
            orderIndex: assignment.orderIndex ?? null,
          },
        },
      }),
    );

    return {
      messages: [
        // Prompt part 0: system prompt — rendered from the role's systemPromptTemplate
        new SystemMessage(systemPrompt),
        // Prompt part 1: role prompt (identity, attitude, domain knowledge, behavioural guidelines)
        ...(role.rolePrompt ? [new HumanMessage(role.rolePrompt)] : []),
        // Prompt part 2: company environment (name, description, shared storage layout, etc.)
        ...(company.companyContext
          ? [new HumanMessage(company.companyContext)]
          : []),
        // Prompt part 3: services available (MCP servers). Call describe_server on any for details.
        ...(servicesMessage ? [servicesMessage] : []),
        // Prompt part 4: assignment presentation (mode prompt + assignment prompt + materials/expected)
        assignmentMessage,
        // Prompt part 5: RAG data retrieved for the initial task (omitted when nothing relevant)
        ...(ragMessage ? [ragMessage] : []),
        // Prompt part 6: episodic memory — recalled prior run summaries relevant to this task (not yet implemented)
        // Prompt part 7: peer context — summaries of currently running sibling agents (not yet implemented)
        // Prompt part 8: final instruction — directs the agent to begin after all context is set
        new HumanMessage(agentPrompts.final_instruction),
      ],
    };
  }

  /**
   * Builds a deterministic completion summary from the tracker data and
   * records it as an {@link AuditEventType.AgentLoopCompletion} event.
   *
   * No LLM call — the tracked actions and storage changes are already
   * precise and complete, so an LLM-authored abstractive summary added
   * narrative framing but no new facts, at the cost of an extra round-trip
   * on every completed run.
   */
  private recordCompletionSummary(
    agent: LcpAgent,
    tracker: AgentLoopTracker,
  ): void {
    const { actions, storage } = tracker;
    const summary = renderTemplate(
      agentPrompts.completion_summary_deterministic,
      {
        actionLines: actions.length
          ? actions.map((a, i) => `${i + 1}. ${a}`).join('\n')
          : agentPrompts.completion_summary_no_actions,
        created:
          storage.created.join(', ') ||
          agentPrompts.completion_summary_no_storage,
        modified:
          storage.modified.join(', ') ||
          agentPrompts.completion_summary_no_storage,
        deleted:
          storage.deleted.join(', ') ||
          agentPrompts.completion_summary_no_storage,
        moved:
          storage.moved.map((m) => `${m.from} → ${m.to}`).join(', ') ||
          agentPrompts.completion_summary_no_storage,
      },
    );

    const completionSummary: AgentLoopCompletionSummary = {
      summary,
      actions,
      storage,
    };
    this.auditClient.record(
      agent.companyId,
      agent.role.name,
      agent.id,
      AuditEventType.AgentLoopCompletion,
      completionSummary,
    );
  }

  /**
   * Persists a new lifecycle status for the agent to the database.
   * Optionally also sets the LangGraph `threadId` (used on the first run to
   * bind the agent's UUID as the checkpoint thread identifier).
   */
  private async updateStatus(
    agent: LcpAgent,
    status: AgentStatus,
    threadId?: string,
  ): Promise<void> {
    await this.agentRepo.update(agent.id, {
      status,
      ...(threadId !== undefined && { threadId }),
    });
    // Surface the worker's lifecycle transitions to observing SSE clients.
    // Terminal `completed`/`failed` events (carrying the response/error) are
    // emitted separately by lcp-server once notifyComplete/notifyFailed lands.
    this.events.publish(agent.id, {
      timestamp: new Date().toISOString(),
      kind: 'agent_status',
      data: { status },
    });
  }

  /**
   * Writes an {@link AuditEventType.StateChange} event capturing the reason for
   * a status transition (e.g. timeout, max iterations, unhandled error).
   */
  private recordStateChange(
    agent: LcpAgent,
    newStatus: string,
    reason: string,
  ): void {
    this.auditClient.record(
      agent.companyId,
      agent.role.name,
      agent.id,
      AuditEventType.StateChange,
      { newStatus, reason },
    );
  }
}
