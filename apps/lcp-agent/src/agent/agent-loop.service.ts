import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { END, MessagesAnnotation, StateGraph } from '@langchain/langgraph';
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import {
  AgentStatus,
  AuditEventType,
  LcpAgent,
  LcpCompany,
  LcpRole,
  LlmConfig,
} from '@lcp/shared';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { UUID } from 'crypto';
import { Repository } from 'typeorm';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import { AuditClientService } from '../audit/audit-client.service';
import { buildChatModel } from '../llm/llm-factory';
import { McpClientService } from '../mcp/mcp-client.service';
import { AgentRagService } from '../rag/agent-rag.service';
import { AgentRegistryService } from '../registry/agent-registry.service';
import { agentPrompts } from '../agent-prompts';

/** Hard limits applied to every agent run. */
const MAX_ITERATIONS = 10;
const TIMEOUT_MS = 60_000;

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
 * Resource limits (hard-coded for MVP):
 * - {@link MAX_ITERATIONS} node entries before the run is cancelled as failed
 * - {@link TIMEOUT_MS} wall-clock timeout before the run is cancelled as failed
 * ponytail: move limits to LcpRole.runConfig JSONB once per-role tuning is needed
 *
 * **Pause/resume flow:**
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

    const abortController = new AbortController();
    const timeoutId = setTimeout(
      () => abortController.abort('timeout'),
      TIMEOUT_MS,
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
        replyContent,
      );
    } finally {
      clearTimeout(timeoutId);
      await checkpointer.end();
      this.registry.deregister(agentId);
    }
  }

  private async runLoop(
    agent: LcpAgent,
    role: LcpRole,
    company: LcpCompany | null,
    llmConfig: LlmConfig,
    checkpointer: PostgresSaver,
    abortController: AbortController,
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

    try {
      const lastAiMessage = await this.streamAndAudit(
        graph,
        input,
        config,
        agent,
        role,
        abortController,
      );

      if (abortController.signal.aborted) {
        const reason = String(abortController.signal.reason ?? 'unknown');
        this.recordStateChange(agent, role, 'failed', reason);
        await this.updateStatus(agent, AgentStatus.Failed);
        return;
      }

      // A tool call may have set the agent to Paused or Completed during the stream
      const freshAgent = await this.agentRepo.findOneBy({ id: agent.id });
      if (
        freshAgent?.status === AgentStatus.Paused ||
        freshAgent?.status === AgentStatus.Completed
      ) {
        this.logger.log(
          `Agent ${agent.id} loop ending with status '${freshAgent.status}' (set by tool call)`,
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
   * Streams graph events, writes audit rows, and returns the last AI message.
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
  ): Promise<AIMessage | undefined> {
    let lastAiMessage: AIMessage | undefined;
    let iterations = 0;

    const stream = graph.streamEvents(input, { ...config, version: 'v2' });
    for await (const event of stream) {
      if (event.event === 'on_chat_model_start') {
        iterations++;
        if (iterations > MAX_ITERATIONS) {
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

      // Pause detection: a tool call (e.g. request_user_input, complete_task) may
      // have mutated the agent's status — exit the stream gracefully if so
      if (event.event === 'on_tool_end') {
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
        // Prompt part 8: final instruction — directs the agent to begin after all context is set
        new HumanMessage(agentPrompts.final_instruction),
      ],
    };
  }

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

/**
 * Reads MCP server URLs from environment variables.
 * Convention: `MCP_{NAME_UPPER}_URL` — e.g. `MCP_STORAGE_URL`.
 */
function resolveMcpServerUrls(config: ConfigService): Record<string, string> {
  const urls: Record<string, string> = {};
  for (const name of ['storage', 'memory', 'interactions']) {
    const url = config.get<string>(`MCP_${name.toUpperCase()}_URL`);
    if (url) urls[name] = url;
  }
  return urls;
}

/** Formats the services-available message for prompt part 3. */
function buildServicesMessage(
  serverNames: string[],
  serverUrls: Record<string, string>,
): string {
  const lines = serverNames
    .filter((n) => serverUrls[n])
    .map(
      (n) =>
        `- **${n}**: call \`${n}__describe_server\` for a full tool list and usage guide`,
    );

  if (lines.length === 0) return '';

  return (
    '## Available Services\n\n' +
    'You have access to the following external services via tools. ' +
    'Each service exposes a `describe_server` tool — call it to learn exactly what tools are available and how to use them before making calls.\n\n' +
    lines.join('\n')
  );
}

/** Formats RAG chunks as a prompt part 5 message. */
function buildRagMessage(
  chunks: { documentPath: string; content: string }[],
): string {
  const sections = chunks
    .map((c) => `### Source: ${c.documentPath}\n\n${c.content}`)
    .join('\n\n---\n\n');
  return `The following excerpts from your knowledge base are relevant to your current task. Draw on them as needed:\n\n${sections}`;
}
