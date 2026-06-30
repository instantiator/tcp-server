import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import {
  AgentStatus,
  AuditEventType,
  DEFAULT_LLM_CONTEXT_WINDOW,
  LcpAgent,
  LcpCompany,
  LcpRole,
  McpClientService,
  buildAgentGraph,
  buildChatModel,
  renderTemplate,
  resolveEnvLlmConfig,
  resolveMcpServerUrls,
} from '@lcp/shared';
import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { UUID } from 'crypto';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { ContextManagerService } from '../context/context-manager.service';
import type { CompactionReport } from '../context/context.types';
import { AgentEventService } from '../events/agent-event.service';
import { RagRetrievalService } from '../rag/rag-retrieval.service';

/**
 * Prompt part 8 — appended as the last message on the initial turn only.
 * Gives the agent a clear directive to begin work after all context has been
 * established by the preceding prompt parts.
 */
const FINAL_INSTRUCTION =
  'You have been given your task and all relevant context above. Proceed now: be thorough, draw on your expertise, and deliver your best work.';

/** Response returned by {@link ChatService.sendMessage}. */
export interface ChatMessageResponse {
  /** The agent's reply text. Empty string when the request was cancelled. */
  response: string;
  /**
   * Present when the server compacted the context window before or during
   * this turn. Includes strategy names, activities, duration, and token counts.
   */
  compactionReport?: CompactionReport;
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
   * Sends a message to an existing chat agent and returns the agent's response.
   *
   * On the first message (when `agent.threadId` is null), the role's system
   * prompt is prepended so the LLM knows its persona. Subsequent messages are
   * appended to the existing LangGraph checkpoint thread.
   *
   * Context compaction runs before each invocation when the conversation
   * history approaches the configured context window limit. See
   * {@link ContextManagerService} for compaction details.
   *
   * @param agentId - ID of the chat agent to send the message to.
   * @param message - User message text.
   * @param signal - Optional {@link AbortSignal} to cancel the in-flight LLM call.
   *   When aborted, the agent is returned to `idle` status rather than `failed`.
   *
   * @throws {@link NotFoundException} when the agent or its role/LLM config cannot be found.
   * @throws {@link InternalServerErrorException} when the LLM call fails unexpectedly.
   */
  async sendMessage(
    agentId: UUID,
    message: string,
    signal?: AbortSignal,
  ): Promise<ChatMessageResponse> {
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

    const databaseUrl = this.config.getOrThrow<string>('DATABASE_URL');
    const checkpointer = PostgresSaver.fromConnString(databaseUrl);

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
      const graph = buildAgentGraph({
        model,
        checkpointer,
        tools: langchainTools,
        signal,
        logger: this.logger,
      });

      const runConfig = { configurable: { thread_id: agentId } };

      // Check context budget and compact if needed before invoking
      this.agentEvents.emit(agentId, {
        kind: 'processing_started',
        timestamp: new Date().toISOString(),
      });
      const { message: preparedMessage, report: compactionReport } =
        await this.contextManager.prepare(
          agentId,
          message,
          model,
          windowSize,
          graph,
          runConfig,
          isFirstMessage,
          agent,
          role,
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

      const result = await graph.invoke({ messages }, { ...runConfig, signal });

      const last = result.messages.at(-1);
      const content =
        last instanceof AIMessage && typeof last.content === 'string'
          ? last.content.trim()
          : '';

      await this.audit.record(
        agent.companyId,
        role.name,
        agent.id,
        AuditEventType.LlmResponse,
        { response: content },
      );
      await this.agentRepo.update(agentId, { status: AgentStatus.Idle });
      this.agentEvents.emit(agentId, {
        kind: 'processing_complete',
        timestamp: new Date().toISOString(),
      });

      return {
        response: content,
        compactionReport: compactionReport ?? undefined,
      };
    } catch (err) {
      // Client-side cancellations (`AbortError`) are not a failure.
      // This returns the agent to idle.
      if (
        String(err).includes('Aborted') ||
        (err instanceof Error &&
          (err.name === 'AbortError' ||
            (signal?.aborted && err.message.includes('abort'))))
      ) {
        await this.audit.record(
          agent.companyId,
          role.name,
          agent.id,
          AuditEventType.StateChange,
          { newStatus: 'idle', reason: 'cancelled by user' },
        );
        await this.agentRepo.update(agentId, { status: AgentStatus.Idle });
        return { response: '' };
      }

      // err was not a cancellation - move to failed state.
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
      throw new InternalServerErrorException(
        `Agent encountered an unexpected error.`,
      );
    } finally {
      await checkpointer.end();
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
    'Each service exposes a `describe_server` tool — call it to learn exactly what tools are available and how to use them before making calls.\n\n' +
    lines.join('\n');

  return [new HumanMessage(text)];
}

/** Strips characters unsafe for use as a MinIO path component. */
function sanitiseSlug(slug: string): string {
  return slug.replace(/[^a-zA-Z0-9_-]/g, '_');
}
