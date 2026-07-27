import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import {
  AgentStatus,
  AuditEventType,
  ContextManagerService,
  DEFAULT_LLM_CONTEXT_WINDOW,
  DEFAULT_RAG_THRESHOLD,
  TcpAgent,
  TcpAssignment,
  TcpCompany,
  TcpRole,
  LlmConfig,
  McpClientService,
  PromptAssemblyStrings,
  buildAgentGraph,
  buildAssignmentMessage,
  buildChatModel,
  buildRagMessage,
  buildServicesMessage,
  enrichedAuditForEvent,
  mapStreamDeltas,
  renderSystemPrompt,
  resolveEmbeddingConfig,
  resolveEnvEmbeddingConfig,
  resolveEnvLlmConfig,
  resolveLlmConfig,
  resolveMcpServerList,
  resolveMcpServerUrls,
  resolveRunConfig,
  runSupervisedGraph,
} from '@tcp/shared';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { UUID } from 'crypto';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { AgentEventService } from '../events/agent-event.service';
import { RagRetrievalService } from '../rag/rag-retrieval.service';
import { claimStatus } from './claim-status';

/**
 * Prompt part 8 — appended as the last message on the initial turn only.
 * Gives the agent a clear directive to begin work after all context has been
 * established by the preceding prompt parts.
 */
const FINAL_INSTRUCTION =
  'You have been given your task and all relevant context above. Proceed now: be thorough, draw on your expertise, and deliver your best work.';

/**
 * Fixed strings for the shared prompt-part builders (see
 * {@link PromptAssemblyStrings}). tcp-server supplies its own set, mirroring
 * tcp-agent's jsonc-loaded `agentPrompts`, so chat and worker turns render the
 * same structure.
 */
const CHAT_PROMPT_STRINGS: PromptAssemblyStrings = {
  services_header: '## Available Services',
  services_intro:
    "You have access to the following external services via tools. Each service's other tools only become available once you call its `describe_server` tool — they stay available for a few turns, then are hidden again until you re-describe. Be sparing: only describe a service you actually need for the current step.",
  services_item: '- **{{name}}**: use for {{usage}}',
  services_item_unknown:
    '- **{{name}}**: call `{{name}}__describe_server` for a full tool list and usage guide',
  rag_intro:
    'The following excerpts from your knowledge base are relevant to your current task. Draw on them as needed:',
  rag_source_header: '### Source: {{documentPath}}',
  assignment_materials_header:
    '## Materials (each name below is read via `read_material_file`, not a storage path)',
  assignment_expected_header:
    "## Expected outputs (each filename below is what you pass to `append_working_file`/`create_working_file` and to `complete_assignment`'s `prepared` — not a storage path)",
};

/** Resolved context for one detached chat turn, passed to {@link ChatService.runTurn}. */
interface TurnContext {
  agent: TcpAgent;
  role: TcpRole;
  company: TcpCompany | null;
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
    @InjectRepository(TcpAgent)
    private readonly agentRepo: Repository<TcpAgent>,
    @InjectRepository(TcpAssignment)
    private readonly assignmentRepo: Repository<TcpAssignment>,
    @InjectRepository(TcpRole)
    private readonly roleRepo: Repository<TcpRole>,
    @InjectRepository(TcpCompany)
    private readonly companyRepo: Repository<TcpCompany>,
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
    const agent = await this.agentRepo.findOne({
      where: { id: agentId },
      // The (chat-mode) assignment drives prompt part 4 — same load the worker
      // path uses in AgentLoopService.run.
      relations: { assignment: { task: true } },
    });
    if (!agent) throw new NotFoundException(`Agent ${agentId} not found`);

    const role = await this.roleRepo.findOneBy({ id: agent.roleId });
    if (!role) throw new NotFoundException(`Role ${agent.roleId} not found`);

    const company = await this.companyRepo.findOneBy({ id: agent.companyId });
    const llmConfig = resolveLlmConfig(
      role,
      company,
      resolveEnvLlmConfig(this.config),
    );
    if (!llmConfig) {
      throw new NotFoundException(
        `No LLM config for agent ${agentId}: role has no llmConfig, company has no llmConfig, and no LLM env fallback is configured`,
      );
    }

    const windowSize =
      Number(llmConfig.contextWindow) || DEFAULT_LLM_CONTEXT_WINDOW;
    const isFirstMessage = agent.threadId === null;

    await this.agentRepo.update(agentId, {
      status: AgentStatus.Running,
      ...(isFirstMessage && { threadId: agentId }),
    });
    // The typed message renders from its `input` event as it arrives over SSE
    // (no local echo — decision 1); the running transition is a state_change.
    await this.audit.record(
      agent.companyId,
      role.name,
      agent.id,
      AuditEventType.Input,
      { text: message },
    );
    await this.audit.record(
      agent.companyId,
      role.name,
      agent.id,
      AuditEventType.StateChange,
      { entity: 'agent', newStatus: AgentStatus.Running },
    );

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
      // Additive union: default registry servers, plus any extras from the
      // company and the role (not a precedence chain — every source contributes).
      const mcpServerNames = resolveMcpServerList(
        Object.keys(mcpServerUrls),
        company,
        role,
      );
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
      // All tools are bound from turn 1 (compact schemas) — no describe-then-
      // reveal gating. Chat leaves `tool_choice` on auto so a turn can end with
      // a prose reply rather than a forced tool call.
      const graph = buildGraph(langchainTools);

      const runConfig = { configurable: { thread_id: agentId } };

      // Check context budget and compact if needed before invoking. Compaction
      // writes its own `compaction` audit rows (streamed live); the running
      // transition was already recorded by sendMessage.
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
        langchainTools,
      );

      let ragMessage: HumanMessage | null = null;
      if (isFirstMessage) {
        const ragChunks = await this.ragRetrieval.retrieve(
          role.id,
          role.companyId,
          preparedMessage,
          resolveEmbeddingConfig(
            company,
            resolveEnvEmbeddingConfig(this.config),
          ),
          undefined,
          resolveRunConfig(
            'ragThreshold',
            role,
            company,
            this.config.get<number>('RAG_THRESHOLD'),
            DEFAULT_RAG_THRESHOLD,
          ),
        );
        if (ragChunks.length) {
          const rawRagText = buildRagMessage(ragChunks, CHAT_PROMPT_STRINGS);
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

      const servicesText = buildServicesMessage(
        [...new Set(mcpTools.map((t) => t.serverName))],
        mcpServerUrls,
        CHAT_PROMPT_STRINGS,
      );
      // Prompt part 4: assignment presentation. For a chat agent this is the
      // chat mode prompt (MODE_PROMPTS.chat) followed by the user's message —
      // built via the same shared builder the worker path uses, so the chat
      // agent now knows it is in a conversation. materials/expected are empty
      // for the chat orphan assignment.
      const assignment = agent.assignment;
      const assignmentMessage = new HumanMessage(
        buildAssignmentMessage(
          {
            mode: assignment.mode,
            prompt: preparedMessage,
            materials: assignment.materials,
            expected: assignment.expected,
            resolutionContext: {
              companySlug: company?.slug ?? '',
              task: assignment.task ?? null,
              assignment: {
                id: assignment.id,
                taskId: assignment.taskId ?? null,
                orderIndex: assignment.orderIndex ?? null,
              },
            },
          },
          CHAT_PROMPT_STRINGS,
        ),
      );
      const messages = isFirstMessage
        ? [
            // Prompt part 0: system prompt — rendered from the resolved systemPromptTemplate
            new SystemMessage(renderSystemPrompt(agent, role, company)),
            // Prompt part 1: role prompt (identity, attitude, domain knowledge, behavioural guidelines)
            ...(role.rolePrompt ? [new HumanMessage(role.rolePrompt)] : []),
            // Prompt part 2: company environment (name, description, shared storage layout, etc.)
            ...(company?.companyContext
              ? [new HumanMessage(company.companyContext)]
              : []),
            // Prompt part 3: services available (MCP servers loaded for this turn)
            ...(servicesText ? [new HumanMessage(servicesText)] : []),
            // Prompt part 4: assignment presentation (chat mode prompt + user message)
            assignmentMessage,
            // Prompt part 5: RAG data retrieved for this query (omitted when nothing relevant)
            ...(ragMessage ? [ragMessage] : []),
            // Prompt part 6: MCP pre-task responses (none for stub servers; wired here for future use)
            // Prompt part 7: conversation history is implicitly provided by the LangGraph
            // checkpoint store keyed on agent.threadId — no explicit injection needed.
            // Prompt part 8: final instruction — directs the agent to begin after all context is set
            new HumanMessage(FINAL_INSTRUCTION),
          ]
        : [new HumanMessage(preparedMessage)];

      // Lifecycle-event audit writes (below) are fired from the synchronous
      // onEvent hook and can't be awaited there — tracked here instead, and
      // flushed before every terminal state_change record, so a slow
      // llm_response write can never be overtaken on the wire by the turn's
      // own completion event (the SSE client stops reading the moment it
      // sees a terminal event, so an out-of-order llm_response is dropped).
      const pendingAuditWrites: Promise<unknown>[] = [];

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
            // Persist each lifecycle event (streamed live by the publisher),
            // and publish token deltas directly to the agent channel.
            const audit = enrichedAuditForEvent(event);
            if (audit) {
              pendingAuditWrites.push(
                this.audit.record(
                  agent.companyId,
                  role.name,
                  agentId,
                  audit.eventType,
                  audit.payload,
                ),
              );
            }
            for (const delta of mapStreamDeltas(event, agentId)) {
              this.agentEvents.emit(agentId, delta);
            }
          },
          checkTerminalStatus: async () => {
            const fresh = await this.agentRepo.findOneBy({ id: agentId });
            return fresh?.status === AgentStatus.Paused ||
              fresh?.status === AgentStatus.Completed
              ? fresh.status
              : null;
          },
        },
      });

      if (result.failureReason) {
        throw new Error(result.failureReason);
      }

      // A consultation or user-input tool may have paused the agent mid-turn.
      // Its resumed BullMQ run — plus PauseAndResumeService — will record the
      // remaining events (including the terminal one), so we stop here. If the
      // consultation cycle raced to Completed while the final LLM turn ran,
      // record the terminal state_change now from the persisted output.
      if (result.terminalStatus === AgentStatus.Paused) {
        await closeCheckpointer();
        await Promise.all(pendingAuditWrites);
        return;
      }
      if (result.terminalStatus === AgentStatus.Completed) {
        await closeCheckpointer();
        await Promise.all(pendingAuditWrites);
        const freshAgent = await this.agentRepo.findOneBy({ id: agentId });
        await this.audit.record(
          agent.companyId,
          role.name,
          agent.id,
          AuditEventType.StateChange,
          {
            entity: 'agent',
            newStatus: AgentStatus.Completed,
            reason: 'turn_complete',
            response: freshAgent?.output ?? '',
          },
        );
        return;
      }

      const content =
        typeof result.lastAiMessage?.content === 'string'
          ? result.lastAiMessage.content.trim()
          : '';

      // The turn's llm_response row is written by onEvent (enriched); here we
      // just persist the output and record the terminal transition to idle,
      // which streams live and drives client-side terminal detection. Flush
      // those onEvent-triggered writes first so the CLI's stream — which
      // stops reading as soon as it sees this terminal event — never
      // outraces the llm_response row it depends on for rendering.
      await Promise.all(pendingAuditWrites);
      await this.agentRepo.update(agentId, {
        status: AgentStatus.Idle,
        output: content,
      });
      await this.audit.record(
        agent.companyId,
        role.name,
        agent.id,
        AuditEventType.StateChange,
        {
          entity: 'agent',
          newStatus: AgentStatus.Idle,
          reason: 'turn_complete',
          response: content,
        },
      );
    } catch (err) {
      // The turn is detached — record the failure as a terminal state_change
      // rather than rethrowing (there is no caller left to catch it).
      const msg =
        err instanceof Error && err.message.trim()
          ? err.message
          : 'unexpected LLM failure';
      this.logger.error(`Chat agent ${agentId} error: ${msg}`);
      await this.audit.record(
        agent.companyId,
        role.name,
        agent.id,
        AuditEventType.StateChange,
        { entity: 'agent', newStatus: 'failed', reason: msg },
      );
      await this.agentRepo.update(agentId, { status: AgentStatus.Failed });
      if (agent.assignmentId) {
        await claimStatus(
          this.assignmentRepo,
          agent.assignmentId,
          'in-progress',
          'failed',
          { failureReason: msg },
        );
      }
    } finally {
      await closeCheckpointer();
    }
  }
}

/** Strips characters unsafe for use as a MinIO path component. */
function sanitiseSlug(slug: string): string {
  return slug.replace(/[^a-zA-Z0-9_-]/g, '_');
}
