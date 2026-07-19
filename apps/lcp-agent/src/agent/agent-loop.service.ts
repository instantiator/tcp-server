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
  LcpAssignment,
  LcpRole,
  LlmConfig,
  StreamEventLike,
  SupervisedGraphResult,
  buildAgentGraph,
  buildAssignmentMessage,
  buildAvailableRolesMessage,
  buildRagMessage,
  buildServicesMessage,
  enrichedAuditForEvent,
  filterToolsForMode,
  mapStreamDeltas,
  renderSystemPrompt,
  renderTemplate,
  requiredToolForMode,
  resolveEnvLlmConfig,
  resolveLlmConfig,
  resolveMcpServerList,
  resolveRunConfig,
  runSupervisedGraph,
  serverNamesForMode,
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
  detectDescribedToolCall,
  extractChatModelText,
  generateActionString,
} from './loop-tracker';

/**
 * The mode completion tools (`create_plan`/`complete_assignment`/
 * `assure_assignment`). If one of these is the required tool yet is absent
 * from an agent's loaded toolset, that is a wiring bug — the mode's own
 * completion server was not offered — not a benign optional skip.
 */
const COMPLETION_TOOLS = new Set(
  (['plan', 'implement', 'qa', 'chat'] as const).flatMap(requiredToolForMode),
);

/**
 * Statuses whose terminal `state_change` is recorded by lcp-server (via
 * notifyComplete/notifyFailed), so {@link AgentLoopService.updateStatus} must
 * not record a duplicate for them.
 */
const TERMINAL_STATUSES = new Set<AgentStatus>([
  AgentStatus.Completed,
  AgentStatus.Failed,
  AgentStatus.Cancelled,
]);

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
    @InjectRepository(LcpRole)
    private readonly roleRepo: Repository<LcpRole>,
    @InjectRepository(LcpAssignment)
    private readonly assignmentRepo: Repository<LcpAssignment>,
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
    const mode = agent.assignment?.mode ?? 'implement';
    const mcpServerUrls = resolveMcpServerUrls(this.config);
    // Additive union: default registry servers, plus any extras from the
    // company and the role (not a precedence chain — every source contributes).
    // Then narrow to the servers the assignment mode is allowed — a `plan`
    // agent drops `interactions` entirely (no consultation, no user queries),
    // so it is never even contacted.
    let mcpServerNames = serverNamesForMode(
      resolveMcpServerList(
        Object.keys(mcpServerUrls),
        agent.company,
        agent.role,
      ),
      mode,
    );
    // Don't offer the knowledge (memory) service to a role whose knowledge base
    // is empty — there is nothing for it to search, so it only wastes turns.
    const hasKnowledge = await this.rag.hasKnowledge(
      agent.role.id,
      agent.company.id,
    );
    if (!hasKnowledge) {
      mcpServerNames = mcpServerNames.filter((n) => n !== 'memory');
    }
    // Filter the loaded tools by mode too — a `plan` agent keeps the storage
    // server for read-only inspection but loses its mutating tools, so it
    // cannot short-circuit into doing the work instead of planning it.
    const mcpTools = filterToolsForMode(
      await this.mcp.loadTools(mcpServerNames, mcpServerUrls, {
        agentId: agent.id,
        companyId: agent.companyId,
      }),
      mode,
    );
    const langchainTools = mcpTools.map((t) => t.tool);

    const model = buildChatModel(llmConfig);
    // Work modes (plan/implement/qa) MUST end in a tool call, so force one every
    // turn — the weak local model can't then narrate a tool call instead of
    // invoking it. Chat needs to reply in prose, so it stays on `auto`.
    const toolChoice = mode === 'chat' ? undefined : 'required';
    const buildGraph = (tools: DynamicStructuredTool[]) =>
      buildAgentGraph({
        model,
        checkpointer,
        tools,
        logger: this.logger,
        interruptAfterTools: true,
        signal: abortController.signal,
        toolChoice,
      });
    // All mode-filtered tools are bound from turn 1 (their schemas are compact,
    // ~1k tokens per mode) — no describe-then-reveal gating, which cost the slow
    // model extra round-trips and let it "forget" a tool after a few iterations.
    const graph = buildGraph(langchainTools);

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
      langchainTools,
    );

    // Resume path: inject reply as the next message; checkpoint holds prior state
    const input: typeof MessagesAnnotation.State = !isFirstMessage
      ? { messages: [new HumanMessage(preparedMessage)] }
      : await this.buildInitialState(
          agent,
          mcpTools,
          mcpServerUrls,
          preparedMessage,
          hasKnowledge,
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
      if (result.terminalStatus === AgentStatus.Cancelled) {
        // Task cancellation already set this status (and recorded the audit
        // event) — just stop the loop, no further writes.
        this.logger.log(`Agent ${agent.id} loop ending: task cancelled`);
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
        onEvent,
        checkTerminalStatus: async () => {
          const fresh = await this.agentRepo.findOneBy({ id: ctx.agent.id });
          return fresh?.status === AgentStatus.Paused ||
            fresh?.status === AgentStatus.Completed ||
            fresh?.status === AgentStatus.Cancelled
            ? fresh.status
            : null;
        },
        maxIterations: ctx.maxIterations,
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
      // Persist each lifecycle event with an enriched payload (tool name/input/
      // output, response/reasoning text) — the server streams it live. Token
      // deltas are published directly to the agent's Redis channel.
      const audit = enrichedAuditForEvent(event);
      if (audit) {
        this.auditClient.record(
          agent.companyId,
          agent.role.name,
          agent.id,
          audit.eventType,
          audit.payload,
        );
      }
      for (const delta of mapStreamDeltas(event, agent.id)) {
        this.events.publish(delta);
      }

      if (event.event === 'on_chat_model_end') {
        tracker.lastResponseText = extractChatModelText(event.data?.output);
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
      // A missing completion tool means the mode's own completion server was
      // not offered — a wiring bug that will let the run end without ever
      // completing its assignment. Louder than a benign optional-tool skip.
      const level = COMPLETION_TOOLS.has(toolName) ? 'error' : 'warn';
      this.logger[level](
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
      const describedCall = detectDescribedToolCall(tracker.lastResponseText);
      const nudge = missing.length
        ? describedCall
          ? renderTemplate(
              agentPrompts.required_tools_reminder_with_described_call,
              {
                tools: missing.map(callableName).join(', '),
                describedCall,
              },
            )
          : renderTemplate(agentPrompts.required_tools_reminder, {
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
      if (result.terminalStatus === AgentStatus.Cancelled) {
        this.logger.log(
          `Agent ${agent.id} loop ending during required-tool reminder: task cancelled`,
        );
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
    // The terminal `failed` state_change (with reason) is recorded by
    // lcp-server's failAgent via notifyFailed below — no local duplicate.
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
    hasKnowledge: boolean,
  ): Promise<typeof MessagesAnnotation.State> {
    const { role, company, assignment } = agent;
    const systemPrompt = renderSystemPrompt(agent, role, company);

    // Skip RAG entirely (including the embedding call) when the role has no
    // indexed knowledge — there is nothing to retrieve.
    const ragChunks = hasKnowledge
      ? await this.rag.retrieve(
          role.id,
          company.id,
          initialPrompt,
          company.embeddingConfig,
        )
      : [];
    const ragMessage = ragChunks.length
      ? new HumanMessage(buildRagMessage(ragChunks, agentPrompts))
      : null;

    const loadedServerNames = [...new Set(mcpTools.map((t) => t.serverName))];
    const servicesText = buildServicesMessage(
      loadedServerNames,
      mcpServerUrls,
      agentPrompts,
    );
    const servicesMessage = servicesText
      ? new HumanMessage(servicesText)
      : null;

    // The task's implement-mode plan, needed to resolve any
    // `assignment-completed-path` material/expected artifact (a prior step's
    // approved output) — see `resolveArtifactKey`. Only fetched for a task
    // assignment; an orphan (chat/consultation) assignment has no plan.
    const planAssignments = assignment.taskId
      ? (
          await this.assignmentRepo.find({
            where: { taskId: assignment.taskId, mode: 'implement' },
          })
        ).map((a) => ({ orderIndex: a.orderIndex, approved: a.approved }))
      : undefined;

    // Prompt part 4: assignment presentation — the mode prompt plus the
    // assignment prompt (already context-prepared as `initialPrompt`) and any
    // materials/expected outputs. Replaces the old bare initial-prompt message.
    const assignmentMessage = new HumanMessage(
      buildAssignmentMessage(
        {
          mode: assignment.mode,
          prompt: initialPrompt,
          materials: assignment.materials,
          expected: assignment.expected,
          resolutionContext: {
            companySlug: company.slug,
            task: assignment.task ?? null,
            planAssignments,
            assignment: {
              id: assignment.id,
              taskId: assignment.taskId ?? null,
              orderIndex: assignment.orderIndex ?? null,
            },
          },
        },
        agentPrompts,
      ),
    );

    // Plan-mode agents assign each step to a role — give them the company's
    // role roster up front so they pick a real role by its exact slug rather
    // than inventing one (and, on a wrong guess, create_plan names the valid
    // roles too). Only fetched for plan mode; other modes assign no roles.
    let rolesMessage: HumanMessage | null = null;
    if (assignment.mode === 'plan') {
      const companyRoles = await this.roleRepo.findBy({
        companyId: company.id,
      });
      const rolesText = buildAvailableRolesMessage(companyRoles);
      if (rolesText) rolesMessage = new HumanMessage(rolesText);
    }

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
        // Prompt part 4b: available roles (plan mode only) — the roster a planner assigns steps to
        ...(rolesMessage ? [rolesMessage] : []),
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
    // Record non-terminal transitions (e.g. running) as a state_change the
    // server streams live. Terminal transitions (completed/failed/cancelled)
    // are recorded by lcp-server's completeAgent/failAgent once
    // notifyComplete/notifyFailed lands — carrying the response/reason — so we
    // don't duplicate them here.
    if (!TERMINAL_STATUSES.has(status)) {
      this.auditClient.record(
        agent.companyId,
        agent.role.name,
        agent.id,
        AuditEventType.StateChange,
        { entity: 'agent', newStatus: status },
      );
    }
  }
}
