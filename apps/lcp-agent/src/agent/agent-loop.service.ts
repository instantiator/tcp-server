import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import { END, MessagesAnnotation, StateGraph } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt';
import {
  AgentLoopCompletionSummary,
  AgentStatus,
  AuditClientService,
  AuditEventType,
  LcpAgent,
  LcpCompany,
  LcpRole,
  LlmConfig,
  resolveRunConfig,
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
import { AgentRegistryService } from '../registry/agent-registry.service';
import { StorageTrackingClientService } from '../storage-tracking/storage-tracking-client.service';
import {
  AgentLoopTracker,
  applyStorageResult,
  createTracker,
  generateActionString,
} from './loop-tracker';

/** Default maximum LLM invocations per run when no override is configured. */
const DEFAULT_AGENT_ITERATIONS = 10;

/** Default wall-clock timeout in milliseconds when no override is configured. */
const DEFAULT_AGENT_LOOP_TIMEOUT_MS = 60_000;

/** Maps LangGraph v2 event names to {@link AuditEventType} values. */
const EVENT_TYPE_MAP: Record<string, AuditEventType> = {
  on_chat_model_start: AuditEventType.LlmRequest,
  on_chat_model_end: AuditEventType.LlmResponse,
  on_tool_start: AuditEventType.ToolCall,
  on_tool_end: AuditEventType.ToolResult,
};

/**
 * Executes and manages the LangGraph agent loop for a single {@link LcpAgent} run.
 *
 * Each call to {@link AgentLoopService.run} corresponds to one BullMQ job.
 * State is persisted to PostgreSQL via the LangGraph checkpoint store so that
 * the agent can be resumed after an interruption.
 *
 * Resource limits — resolved at run-time in precedence order:
 * 1. {@link LcpRole.runConfig} → 2. {@link LcpCompany.runConfig} → 3. env vars
 *    (`AGENT_ITERATIONS`, `AGENT_LOOP_TIMEOUT_MS`) → 4. code defaults
 *    ({@link DEFAULT_AGENT_ITERATIONS}, {@link DEFAULT_AGENT_LOOP_TIMEOUT_MS})
 *
 * **Pause/resume flow:**
 *
 * When an agent calls `request_user_input` or `request_agent_consultation` via
 * the interactions MCP server, lcp-server sets the agent's status to
 * {@link AgentStatus.Paused}. After each tool result event,
 * {@link streamAndAudit} re-reads the agent status; detecting Paused causes an
 * early exit so the BullMQ job completes normally without marking the agent
 * failed. On resume, lcp-server enqueues a new job with `replyContent` which
 * is injected as the first HumanMessage into the resumed LangGraph stream.
 */
@Injectable()
export class AgentLoopService {
  private readonly logger = new Logger(AgentLoopService.name);
  private readonly databaseUrl: string;

  constructor(
    private readonly registry: AgentRegistryService,
    private readonly rag: AgentRagService,
    private readonly mcp: McpClientService,
    private readonly config: ConfigService,
    private readonly auditClient: AuditClientService,
    private readonly storageTracking: StorageTrackingClientService,
    @InjectRepository(LcpAgent)
    private readonly agentRepo: Repository<LcpAgent>,
    @InjectRepository(LcpRole)
    private readonly roleRepo: Repository<LcpRole>,
    @InjectRepository(LcpCompany)
    private readonly companyRepo: Repository<LcpCompany>,
  ) {
    this.databaseUrl = this.config.getOrThrow<string>('DATABASE_URL');
  }

  /**
   * Runs (or resumes) the agent loop for the given agent.
   *
   * @param replyContent - When provided, the agent is resuming from a pause.
   *   The content is injected as the first HumanMessage instead of rebuilding
   *   the full initial-state prompt from scratch.
   */
  async run(agentId: UUID, replyContent?: string): Promise<void> {
    const agent = await this.agentRepo.findOneBy({ id: agentId });
    if (!agent) {
      this.logger.error(`Agent ${agentId} not found — skipping job`);
      return;
    }

    const role = await this.roleRepo.findOneBy({ id: agent.roleId });
    if (!role) {
      this.logger.error(`Role ${agent.roleId} not found for agent ${agentId}`);
      return;
    }

    const company = await this.companyRepo.findOneBy({ id: agent.companyId });
    const llmConfig = role.llmConfig ?? company?.llmDefault;

    if (!llmConfig) {
      this.logger.error(
        `No LLM config for agent ${agentId}: role has no llmConfig and company has no llmDefault`,
      );
      await this.updateStatus(agent, AgentStatus.Failed);
      return;
    }

    const maxIterations = resolveRunConfig(
      'maxIterations',
      role,
      company ?? null,
      this.config.get<number>('AGENT_ITERATIONS'),
      DEFAULT_AGENT_ITERATIONS,
    );
    const timeoutMs = resolveRunConfig(
      'timeoutMs',
      role,
      company ?? null,
      this.config.get<number>('AGENT_LOOP_TIMEOUT_MS'),
      DEFAULT_AGENT_LOOP_TIMEOUT_MS,
    );

    const abortController = new AbortController();

    /** Cancels the run after the resolved wall-clock timeout. */
    const timeoutId = setTimeout(
      () => abortController.abort('timeout'),
      timeoutMs,
    );

    this.registry.register(agentId, abortController);
    await this.updateStatus(agent, AgentStatus.Running, agentId);

    const checkpointer = PostgresSaver.fromConnString(this.databaseUrl);
    try {
      await checkpointer.setup();
      await this.runLoop(
        agent,
        role,
        company,
        llmConfig,
        checkpointer,
        abortController,
        maxIterations,
        replyContent,
      );
    } finally {
      clearTimeout(timeoutId);
      await checkpointer.end();
      this.registry.deregister(agentId);
    }
  }

  /**
   * Orchestrates a single agent run or resume within an established resource
   * envelope (checkpointer, abort signal).
   *
   * Loads MCP tools from the role's permitted server list, builds the LangGraph
   * graph, constructs the input state (resume path vs. full initial-state build),
   * then delegates to {@link streamAndAudit}. Handles post-stream status
   * resolution: paused (early exit), completed (generate summary), or
   * fallback completion when the loop ends without an explicit tool call.
   */
  private async runLoop(
    agent: LcpAgent,
    role: LcpRole,
    company: LcpCompany | null,
    llmConfig: LlmConfig,
    checkpointer: PostgresSaver,
    abortController: AbortController,
    maxIterations: number,
    replyContent?: string,
  ): Promise<void> {
    const mcpServerUrls = resolveMcpServerUrls(this.config);
    const mcpTools = await this.mcp.loadTools(
      role.mcpServerList ?? [],
      mcpServerUrls,
    );
    const langchainTools = mcpTools.map((t) => t.tool);

    const model = buildChatModel(llmConfig);
    const graph = this.buildGraph(model, checkpointer, langchainTools);

    const config = {
      configurable: { thread_id: agent.id },
      signal: abortController.signal,
    };

    // Resume path: inject reply as the next message; checkpoint holds prior state
    const input: typeof MessagesAnnotation.State =
      replyContent !== undefined
        ? { messages: [new HumanMessage(replyContent)] }
        : await this.buildInitialState(
            agent,
            role,
            company,
            mcpTools,
            mcpServerUrls,
          );

    const tracker = createTracker();

    try {
      const lastAiMessage = await this.streamAndAudit(
        graph,
        input,
        config,
        agent,
        role,
        abortController,
        tracker,
        maxIterations,
      );

      if (abortController.signal.aborted) {
        const reason = String(abortController.signal.reason ?? 'unknown');
        this.recordStateChange(agent, role, 'failed', reason);
        await this.updateStatus(agent, AgentStatus.Failed);
        return;
      }

      // A tool call may have set the agent to Paused or Completed during the stream
      const freshAgent = await this.agentRepo.findOneBy({ id: agent.id });
      if (freshAgent?.status === AgentStatus.Paused) {
        this.logger.log(
          `Agent ${agent.id} loop ending with status 'paused' (set by tool call)`,
        );
        return;
      }
      if (freshAgent?.status === AgentStatus.Completed) {
        this.logger.log(
          `Agent ${agent.id} loop ending with status 'completed' (set by tool call)`,
        );
        await this.generateAndRecordCompletionSummary(
          agent,
          role,
          model,
          tracker,
        );
        return;
      }

      const rawContent = lastAiMessage?.content;
      const content = (typeof rawContent === 'string' ? rawContent : '').trim();
      if (!content) {
        // One retry: ask the agent to continue with an explicit continuation prompt
        this.logger.warn(`Agent ${agent.id} produced empty output — retrying`);
        await this.streamAndAudit(
          graph,
          { messages: [new HumanMessage('Please provide your response.')] },
          config,
          agent,
          role,
          abortController,
          tracker,
          maxIterations,
        );
      }

      // Fallback completion — notifyComplete is idempotent if complete_task was called
      const output = content || '';
      this.auditClient.notifyComplete(agent.id, output);
      await this.updateStatus(agent, AgentStatus.Completed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Agent ${agent.id} loop error: ${msg}`);
      this.recordStateChange(agent, role, 'failed', msg);
      await this.updateStatus(agent, AgentStatus.Failed);
    }
  }

  /**
   * Constructs and compiles the LangGraph {@link StateGraph} for this run.
   *
   * Wires a single `agent` node (LLM invoke) and, when tools are present, a
   * `tools` node ({@link ToolNode}) with a conditional edge from agent → tools
   * or END. When no tools are provided the graph terminates after the first LLM
   * invocation. The compiled graph is bound to the given {@link checkpointer}
   * so state is persisted between turns.
   */
  private buildGraph(
    model: ReturnType<typeof buildChatModel>,
    checkpointer: PostgresSaver,
    tools: DynamicStructuredTool[],
  ) {
    const boundModel =
      tools.length > 0 && model.bindTools ? model.bindTools(tools) : model;

    const agentNode = async (state: typeof MessagesAnnotation.State) => {
      const response = await boundModel.invoke(state.messages);
      return { messages: [response] };
    };

    const graph = new StateGraph(MessagesAnnotation)
      .addNode('agent', agentNode)
      .addEdge('__start__', 'agent');

    if (tools.length > 0) {
      graph
        .addNode('tools', new ToolNode(tools))
        .addConditionalEdges('agent', toolsCondition)
        .addEdge('tools', 'agent');
    } else {
      graph.addEdge('agent', END);
    }

    return graph.compile({ checkpointer });
  }

  /**
   * Streams graph events, writes audit rows, tracks tool actions and storage
   * changes, and returns the last AI message plus the accumulated tracker.
   *
   * After each `on_tool_end` event, re-reads the agent status from the DB. If
   * a tool call has set the status to {@link AgentStatus.Paused} or
   * {@link AgentStatus.Completed}, breaks out of the stream early so the BullMQ
   * job can complete without marking the agent failed.
   */
  private async streamAndAudit(
    graph: ReturnType<typeof this.buildGraph>,
    input: typeof MessagesAnnotation.State,
    config: { configurable: { thread_id: string }; signal: AbortSignal },
    agent: LcpAgent,
    role: LcpRole,
    abortController: AbortController,
    tracker: AgentLoopTracker,
    maxIterations: number,
  ): Promise<AIMessage | undefined> {
    let lastAiMessage: AIMessage | undefined;
    let iterations = 0;

    // Correlates on_tool_start inputs to on_tool_end outputs by run_id
    // ponytail: actions include failed tool calls; on_tool_start used for simplicity
    const pendingToolInputs = new Map<string, Record<string, unknown>>();

    const stream = graph.streamEvents(input, { ...config, version: 'v2' });
    for await (const event of stream) {
      if (event.event === 'on_chat_model_start') {
        iterations++;
        if (iterations > maxIterations) {
          abortController.abort('max_iterations');
          break;
        }
      }

      const auditType = EVENT_TYPE_MAP[event.event];
      if (auditType) {
        this.auditClient.record(
          agent.companyId,
          role.name,
          agent.id,
          auditType,
          event.data,
        );
      }

      if (event.event === 'on_chat_model_end') {
        const output = (event.data as { output?: unknown } | undefined)?.output;
        if (output instanceof AIMessage) lastAiMessage = output;
      }

      if (event.event === 'on_tool_start') {
        const input_ =
          (event.data as { input?: Record<string, unknown> } | undefined)
            ?.input ?? {};
        pendingToolInputs.set(event.run_id, input_);
        tracker.actions.push(generateActionString(event.name, input_));
      }

      if (event.event === 'on_tool_end') {
        const toolInput = pendingToolInputs.get(event.run_id) ?? {};
        const output = (event.data as { output?: unknown } | undefined)?.output;
        applyStorageResult(event.name, toolInput, output, tracker);
        pendingToolInputs.delete(event.run_id);
        this.storageTracking.patch(agent.id, tracker.storage);

        // Pause detection: a tool call (e.g. request_user_input, complete_task) may
        // have mutated the agent's status — exit the stream gracefully if so
        const fresh = await this.agentRepo.findOneBy({ id: agent.id });
        if (
          fresh?.status === AgentStatus.Paused ||
          fresh?.status === AgentStatus.Completed
        ) {
          this.logger.log(
            `Agent ${agent.id} status '${fresh.status}' detected after tool result — exiting stream`,
          );
          break;
        }
      }
    }

    return lastAiMessage;
  }

  /** Builds the full initial-state message list for the first run of an agent. */
  private async buildInitialState(
    agent: LcpAgent,
    role: LcpRole,
    company: LcpCompany | null,
    mcpTools: Awaited<ReturnType<McpClientService['loadTools']>>,
    mcpServerUrls: Record<string, string>,
  ): Promise<typeof MessagesAnnotation.State> {
    const systemPrompt = renderTemplate(role.systemPromptTemplate, {
      name: role.name,
      description: role.description,
      date: new Date().toISOString().split('T')[0],
    });

    const ragChunks = await this.rag.retrieve(
      role.id,
      agent.initialPrompt,
      company?.embeddingConfig,
    );
    const ragMessage = ragChunks.length
      ? new HumanMessage(buildRagMessage(ragChunks))
      : null;

    const servicesMessage =
      mcpTools.length > 0
        ? new HumanMessage(
            buildServicesMessage(role.mcpServerList ?? [], mcpServerUrls),
          )
        : null;

    return {
      messages: [
        // Prompt part 0: system prompt — rendered from the role's systemPromptTemplate
        new SystemMessage(systemPrompt),
        // Prompt part 1: role prompt (identity, attitude, domain knowledge, behavioural guidelines)
        ...(role.rolePrompt ? [new HumanMessage(role.rolePrompt)] : []),
        // Prompt part 2: company environment (name, description, shared storage layout, etc.)
        ...(company?.companyContext
          ? [new HumanMessage(company.companyContext)]
          : []),
        // Prompt part 3: services available (MCP servers). Call describe_server on any for details.
        ...(servicesMessage ? [servicesMessage] : []),
        // Prompt part 4: task / query prompt
        new HumanMessage(agent.initialPrompt),
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
   * Generates a short prose summary of the completed agent loop via a direct
   * LLM call and records it as an {@link AuditEventType.AgentLoopCompletion} event.
   *
   * Attempts the LLM call once; on failure retries once more immediately.
   * If both attempts fail, falls back to a structured plaintext summary built
   * from the tracker data so that a completion event is always recorded.
   * ponytail: one retry, then structured fallback — LLM is best-effort for summaries
   */
  private async generateAndRecordCompletionSummary(
    agent: LcpAgent,
    role: LcpRole,
    model: ReturnType<typeof buildChatModel>,
    tracker: AgentLoopTracker,
  ): Promise<void> {
    const { actions, storage } = tracker;

    const invokeForSummary = async (): Promise<string> => {
      const actionLines = actions.length
        ? actions.map((a, i) => `${i + 1}. ${a}`).join('\n')
        : '(none recorded)';
      const prompt = [
        'Your task is now complete.',
        '',
        `Original task: ${agent.initialPrompt}`,
        '',
        'Actions taken (in order):',
        actionLines,
        '',
        'Storage changes:',
        `- Created: ${storage.created.join(', ') || '(none)'}`,
        `- Modified: ${storage.modified.join(', ') || '(none)'}`,
        `- Deleted: ${storage.deleted.join(', ') || '(none)'}`,
        `- Moved: ${storage.moved.map((m) => `${m.from} → ${m.to}`).join(', ') || '(none)'}`,
        '',
        'Respond with ONLY a JSON object — no markdown, no extra text:',
        '{"summary": "One or two sentences describing what was accomplished at a high level."}',
        '',
        'The summary should be concise and factual, suitable for an audit log.',
      ].join('\n');
      const response = await model.invoke([new HumanMessage(prompt)]);
      const raw =
        typeof response.content === 'string' ? response.content.trim() : '';
      // Strip markdown code fences if the model wraps the JSON
      const jsonText = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/, '');
      const parsed = JSON.parse(jsonText) as { summary?: unknown };
      return typeof parsed.summary === 'string' ? parsed.summary : raw;
    };

    let summary = buildFallbackSummary(agent.initialPrompt, actions, storage);
    try {
      summary = await invokeForSummary();
    } catch {
      try {
        summary = await invokeForSummary();
      } catch (e) {
        this.logger.warn(
          `Failed to generate completion summary for agent ${agent.id}: ${String(e)} — using structured fallback`,
        );
      }
    }

    const completionSummary: AgentLoopCompletionSummary = {
      summary,
      actions,
      storage,
    };
    this.auditClient.record(
      agent.companyId,
      role.name,
      agent.id,
      AuditEventType.AgentLoopCompletion,
      completionSummary as unknown as Record<string, unknown>,
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
  }

  /**
   * Writes an {@link AuditEventType.StateChange} event capturing the reason for
   * a status transition (e.g. timeout, max iterations, unhandled error).
   */
  private recordStateChange(
    agent: LcpAgent,
    role: LcpRole,
    newStatus: string,
    reason: string,
  ): void {
    this.auditClient.record(
      agent.companyId,
      role.name,
      agent.id,
      AuditEventType.StateChange,
      { newStatus, reason },
    );
  }
}

/** Replaces `{{key}}` placeholders in a template string with the provided values. */
function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(
    /\{\{(\w+)\}\}/g,
    (_, key: string) => vars[key] ?? '',
  );
}

/** Formats the services-available message for prompt part 3. */
function buildServicesMessage(
  serverNames: string[],
  serverUrls: Record<string, string>,
): string {
  const lines = serverNames
    .filter((n) => serverUrls[n])
    .map((n) => renderTemplate(agentPrompts.services_item, { name: n }));

  if (lines.length === 0) return '';

  return [
    agentPrompts.services_header,
    '',
    agentPrompts.services_intro,
    '',
    lines.join('\n'),
  ].join('\n');
}

/** Formats RAG chunks as a prompt part 5 message. */
function buildRagMessage(
  chunks: { documentPath: string; content: string }[],
): string {
  const sections = chunks
    .map(
      (c) =>
        `${renderTemplate(agentPrompts.rag_source_header, { documentPath: c.documentPath })}\n\n${c.content}`,
    )
    .join('\n\n---\n\n');
  return `${agentPrompts.rag_intro}\n\n${sections}`;
}

/**
 * Builds a structured plaintext summary from raw tracker data.
 * Used as a fallback when the LLM is unavailable during summary generation.
 */
function buildFallbackSummary(
  initialPrompt: string,
  actions: string[],
  storage: AgentLoopCompletionSummary['storage'],
): string {
  const taskSnippet =
    initialPrompt.length > 100
      ? `${initialPrompt.slice(0, 100)}…`
      : initialPrompt;
  const totalFiles =
    storage.created.length +
    storage.modified.length +
    storage.deleted.length +
    storage.moved.length;
  return (
    [
      `Completed task: "${taskSnippet}"`,
      actions.length > 0
        ? `${actions.length} action(s) taken`
        : 'no actions recorded',
      totalFiles > 0 ? `${totalFiles} file(s) affected` : 'no storage changes',
    ].join('; ') + '.'
  );
}
