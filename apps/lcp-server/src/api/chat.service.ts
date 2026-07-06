import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import {
  AgentStatus,
  AuditEventType,
  ContextManagerService,
  DEFAULT_LLM_CONTEXT_WINDOW,
  LcpAgent,
  LcpCompany,
  LcpRole,
  LlmConfig,
  McpClientService,
  ToolVisibilityTracker,
  buildAgentGraph,
  buildChatModel,
  mapStreamEvent,
  renderTemplate,
  resolveEnvLlmConfig,
  resolveMcpServerUrls,
  runSupervisedGraph,
} from '@lcp/shared';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { UUID } from 'crypto';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { AgentEventService } from '../events/agent-event.service';
import { RagRetrievalService } from '../rag/rag-retrieval.service';

/**
 * Prompt part 8 — appended as the last message on the initial turn only.
 * Gives the agent a clear directive to begin work after all context has been
 * established by the preceding prompt parts.
 */
const FINAL_INSTRUCTION =
  'You have been given your task and all relevant context above. Proceed now: be thorough, draw on your expertise, and deliver your best work.';

/** Resolved context for one detached chat turn, passed to {@link ChatService.runTurn}. */
interface TurnContext {
  agent: LcpAgent;
  role: LcpRole;
  company: LcpCompany | null;
  llmConfig: LlmConfig;
  windowSize: number;
  isFirstMessage: boolean;
  message: string;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly contextManager: ContextManagerService,
    private readonly agentEvents: AgentEventService,
    private readonly ragRetrieval: RagRetrievalService,
    private readonly audit: AuditService,
    private readonly mcp: McpClientService,
    @InjectRepository(LcpAgent)
    private readonly agentRepo: Repository<LcpAgent>,
    @InjectRepository(LcpRole)
    private readonly roleRepo: Repository<LcpRole>,
    @InjectRepository(LcpCompany)
    private readonly companyRepo: Repository<LcpCompany>,
  ) {}

  /**
   * Accepts a message for a chat agent and starts the turn, returning as soon
   * as validation passes. The turn itself runs detached (see {@link runTurn});
   * its output — reasoning, response, and completion — is delivered to clients
   * over the `GET /api/agent/:id/events` SSE stream, not this call.
   *
   * On the first message (when `agent.threadId` is null), the role's system
   * prompt is prepended so the LLM knows its persona. Subsequent messages are
   * appended to the existing LangGraph checkpoint thread.
   *
   * @param agentId - ID of the chat agent to send the message to.
   * @param message - User message text.
   *
   * @throws {@link NotFoundException} when the agent or its role/LLM config cannot be found.
   */
  async sendMessage(agentId: UUID, message: string): Promise<void> {
    const agent = await this.agentRepo.findOneBy({ id: agentId });
    if (!agent) throw new NotFoundException(`Agent ${agentId} not found`);

    const role = await this.roleRepo.findOneBy({ id: agent.roleId });
    if (!role) throw new NotFoundException(`Role ${agent.roleId} not found`);

    const company = await this.companyRepo.findOneBy({ id: agent.companyId });
    const llmConfig =
      role.llmConfig ?? company?.llmDefault ?? resolveEnvLlmConfig(this.config);
    if (!llmConfig) {
      throw new NotFoundException(
        `No LLM config for agent ${agentId}: role has no llmConfig, company has no llmDefault, and no LLM env fallback is configured`,
      );
    }

    const windowSize =
      Number(llmConfig.contextWindow) || DEFAULT_LLM_CONTEXT_WINDOW;
    const isFirstMessage = agent.threadId === null;

    await this.agentRepo.update(agentId, {
      status: AgentStatus.Running,
      ...(isFirstMessage && { threadId: agentId }),
    });
    await this.audit.record(
      agent.companyId,
      role.name,
      agent.id,
      AuditEventType.LlmRequest,
      { message },
    );
    this.agentEvents.emit(agentId, {
      timestamp: new Date().toISOString(),
      kind: 'agent_status',
      data: { status: AgentStatus.Running },
    });

    // Detached — runTurn owns the agent's status and emits all turn output on
    // the SSE stream. It never rejects (its catch handles failures), so the
    // fire-and-forget is safe.
    void this.runTurn({
      agent,
      role,
      company,
      llmConfig,
      windowSize,
      isFirstMessage,
      message,
    });
  }

  /**
   * Runs one chat turn to completion in the background, streaming LLM activity,
   * reasoning, and response deltas to SSE observers and persisting the final
   * output. Emits a terminal `completed` (or `failed`) event and returns the
   * agent to `idle` when the turn ends without pausing.
   *
   * When a consultation or user-input tool pauses the agent mid-turn, this
   * returns early: the resumed BullMQ run plus {@link PauseAndResumeService}
   * emit the remaining events (including the terminal one).
   */
  private async runTurn(ctx: TurnContext): Promise<void> {
    const { agent, role, company, llmConfig, windowSize, isFirstMessage } = ctx;
    const { message } = ctx;
    const agentId = agent.id;

    const databaseUrl = this.config.getOrThrow<string>('DATABASE_URL');
    const checkpointer = PostgresSaver.fromConnString(databaseUrl);

    // Guard so the checkpointer connection pool is closed exactly once even
    // when we need to close it early (before returning on a mid-turn pause).
    let checkpointerClosed = false;
    const closeCheckpointer = async () => {
      if (!checkpointerClosed) {
        checkpointerClosed = true;
        await checkpointer.end();
      }
    };

    try {
      await checkpointer.setup();

      const mcpServerUrls = resolveMcpServerUrls(this.config);
      const mcpServerNames = [
        ...new Set([
          ...Object.keys(mcpServerUrls),
          ...(role.mcpServerList ?? []),
        ]),
      ];
      const mcpTools = await this.mcp.loadTools(mcpServerNames, mcpServerUrls, {
        agentId,
        companyId: agent.companyId,
      });
      const langchainTools = mcpTools.map((t) => t.tool);

      const model = buildChatModel(llmConfig);
      const abortController = new AbortController();
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
      // describes it — the initial graph and budget check below must use
      // this same gated set, not the full one, or the very first turn would
      // bind everything regardless.
      const toolVisibility = new ToolVisibilityTracker();
      const initialTools = toolVisibility.resolveVisibleTools(langchainTools);
      const graph = buildGraph(initialTools);

      const runConfig = { configurable: { thread_id: agentId } };

      // Check context budget and compact if needed before invoking. Compaction
      // emits its own SSE events; the running transition was already emitted by
      // sendMessage.
      const { message: preparedMessage } = await this.contextManager.prepare(
        agentId,
        message,
        model,
        windowSize,
        graph,
        runConfig,
        isFirstMessage,
        agent,
        role,
        initialTools,
      );

      let ragMessage: HumanMessage | null = null;
      if (isFirstMessage) {
        const ragChunks = await this.ragRetrieval.retrieve(
          role.id,
          preparedMessage,
          company?.embeddingConfig,
        );
        if (ragChunks.length) {
          const rawRagText = buildRagMessage(ragChunks);
          const overflowPath = company?.slug
            ? `${sanitiseSlug(company.slug)}/tasks/${agentId}/context-overflow`
            : undefined;
          const ragText = await this.contextManager.guardSection(
            rawRagText,
            model,
            windowSize,
            overflowPath,
          );
          ragMessage = new HumanMessage(ragText);
        }
      }

      const messages = isFirstMessage
        ? [
            // Prompt part 0: system prompt — rendered from the role's systemPromptTemplate
            new SystemMessage(
              renderTemplate(role.systemPromptTemplate, {
                name: role.name,
                description: role.description,
                date: new Date().toISOString().split('T')[0],
                companyId: agent.companyId,
                roleId: role.id,
              }),
            ),
            // Prompt part 1: role prompt (identity, attitude, domain knowledge, behavioural guidelines)
            ...(role.rolePrompt ? [new HumanMessage(role.rolePrompt)] : []),
            // Prompt part 2: company environment (name, description, shared storage layout, etc.)
            ...(company?.companyContext
              ? [new HumanMessage(company.companyContext)]
              : []),
            // Prompt part 3: services available (MCP servers loaded for this turn)
            ...buildServicesMessage(
              [...new Set(mcpTools.map((t) => t.serverName))],
              mcpServerUrls,
            ),
            // Prompt part 4: task / query prompt
            new HumanMessage(preparedMessage),
            // Prompt part 5: RAG data retrieved for this query (omitted when nothing relevant)
            ...(ragMessage ? [ragMessage] : []),
            // Prompt part 6: MCP pre-task responses (none for stub servers; wired here for future use)
            // Prompt part 7: conversation history is implicitly provided by the LangGraph
            // checkpoint store keyed on agent.threadId — no explicit injection needed.
            // Prompt part 8: final instruction — directs the agent to begin after all context is set
            new HumanMessage(FINAL_INSTRUCTION),
          ]
        : [new HumanMessage(preparedMessage)];

      // Supervise the turn: check terminal status, context budget, and tool
      // visibility between every tool-loop iteration, instead of letting the
      // graph's tools -> agent edge run unattended to the end. Forwards
      // every LLM/tool/reasoning/response event to observers as it happens
      // and captures the final AI message for persistence.
      const result = await runSupervisedGraph({
        agentId,
        agent,
        role,
        model,
        allTools: langchainTools,
        initialGraph: graph,
        input: { messages },
        config: runConfig,
        contextManager: this.contextManager,
        windowSize,
        abortController,
        hooks: {
          buildGraph,
          onEvent: (event) => {
            toolVisibility.onEvent(event);
            for (const observabilityEvent of mapStreamEvent(event)) {
              this.agentEvents.emit(agentId, observabilityEvent);
            }
          },
          checkTerminalStatus: async () => {
            const fresh = await this.agentRepo.findOneBy({ id: agentId });
            return fresh?.status === AgentStatus.Paused ||
              fresh?.status === AgentStatus.Completed
              ? fresh.status
              : null;
          },
          resolveVisibleTools: (tools) =>
            toolVisibility.resolveVisibleTools(tools),
        },
      });

      if (result.failureReason) {
        throw new Error(result.failureReason);
      }

      // A consultation or user-input tool may have paused the agent mid-turn.
      // Its resumed BullMQ run — plus PauseAndResumeService — will emit the
      // remaining events (including the terminal one), so we stop here. If the
      // consultation cycle raced to Completed while the final LLM turn ran,
      // emit the terminal event now from the persisted output.
      if (result.terminalStatus === AgentStatus.Paused) {
        await closeCheckpointer();
        return;
      }
      if (result.terminalStatus === AgentStatus.Completed) {
        await closeCheckpointer();
        const freshAgent = await this.agentRepo.findOneBy({ id: agentId });
        this.agentEvents.emit(agentId, {
          timestamp: new Date().toISOString(),
          kind: 'completed',
          data: { response: freshAgent?.output ?? '' },
        });
        return;
      }

      const content =
        typeof result.lastAiMessage?.content === 'string'
          ? result.lastAiMessage.content.trim()
          : '';

      await this.audit.record(
        agent.companyId,
        role.name,
        agent.id,
        AuditEventType.LlmResponse,
        { response: content },
      );
      // Persist output so a client that missed the SSE `completed` event can
      // recover it via GET /api/agent/:id (the SSE replay path reads it too).
      await this.agentRepo.update(agentId, {
        status: AgentStatus.Idle,
        output: content,
      });
      this.agentEvents.emit(agentId, {
        timestamp: new Date().toISOString(),
        kind: 'agent_status',
        data: { status: AgentStatus.Idle },
      });
      this.agentEvents.emit(agentId, {
        timestamp: new Date().toISOString(),
        kind: 'completed',
        data: { response: content },
      });
    } catch (err) {
      // The turn is detached — record the failure and emit a terminal event
      // rather than rethrowing (there is no caller left to catch it).
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Chat agent ${agentId} error: ${msg}`);
      await this.audit.record(
        agent.companyId,
        role.name,
        agent.id,
        AuditEventType.StateChange,
        { newStatus: 'failed', reason: msg },
      );
      await this.agentRepo.update(agentId, { status: AgentStatus.Failed });
      this.agentEvents.emit(agentId, {
        timestamp: new Date().toISOString(),
        kind: 'failed',
        data: { error: msg },
      });
    } finally {
      await closeCheckpointer();
    }
  }
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

/**
 * Returns zero or one HumanMessage announcing the MCP services available to the
 * agent. Only includes servers present in `serverUrls` (i.e. those that loaded
 * successfully). Returns an empty array when no services are available.
 */
function buildServicesMessage(
  serverNames: string[],
  serverUrls: Record<string, string>,
): HumanMessage[] {
  const lines = serverNames
    .filter((n) => serverUrls[n])
    .map(
      (n) =>
        `- **${n}**: call \`${n}__describe_server\` for a full tool list and usage guide`,
    );

  if (lines.length === 0) return [];

  const text =
    '## Available Services\n\n' +
    'You have access to the following external services via tools. ' +
    "Each service's other tools only become available once you call its `describe_server` tool — they stay available for a few turns, then are hidden again until you re-describe. " +
    'Be sparing: only describe a service you actually need for the current step.\n\n' +
    lines.join('\n');

  return [new HumanMessage(text)];
}

/** Strips characters unsafe for use as a MinIO path component. */
function sanitiseSlug(slug: string): string {
  return slug.replace(/[^a-zA-Z0-9_-]/g, '_');
}
