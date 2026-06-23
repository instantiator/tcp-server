import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { END, MessagesAnnotation, StateGraph } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import {
  AgentStatus,
  AuditEvent,
  AuditEventType,
  LcpAgent,
  LcpCompany,
  LcpRole,
  buildChatModel,
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
import { ContextManagerService } from '../context/context-manager.service';
import type { CompactionReport } from '../context/context.types';
import { AgentEventService } from '../events/agent-event.service';

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
    @InjectRepository(LcpAgent)
    private readonly agentRepo: Repository<LcpAgent>,
    @InjectRepository(LcpRole)
    private readonly roleRepo: Repository<LcpRole>,
    @InjectRepository(LcpCompany)
    private readonly companyRepo: Repository<LcpCompany>,
    @InjectRepository(AuditEvent)
    private readonly auditRepo: Repository<AuditEvent>,
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

    const llmConfig =
      role.llmConfig ??
      (await this.companyRepo.findOneBy({ id: agent.companyId }))?.llmDefault;
    if (!llmConfig) {
      throw new NotFoundException(
        `No LLM config for agent ${agentId}: role has no llmConfig and company has no llmDefault`,
      );
    }

    const windowSize = llmConfig.contextWindow ?? 8192;
    const isFirstMessage = agent.threadId === null;

    await this.agentRepo.update(agentId, {
      status: AgentStatus.Running,
      ...(isFirstMessage && { threadId: agentId }),
    });

    await this.saveAudit(agent, role, AuditEventType.LlmRequest, { message });

    const databaseUrl = this.config.getOrThrow<string>('DATABASE_URL');
    const checkpointer = PostgresSaver.fromConnString(databaseUrl);

    try {
      await checkpointer.setup();

      const model = buildChatModel(llmConfig);
      const graph = new StateGraph(MessagesAnnotation)
        .addNode('agent', async (state: typeof MessagesAnnotation.State) => ({
          messages: [await model.invoke(state.messages, { signal })],
        }))
        .addEdge('__start__', 'agent')
        // ponytail: conditional edge to tools node goes here once MCP servers exist
        .addEdge('agent', END)
        .compile({ checkpointer });

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
          this.auditRepo,
        );

      const messages = isFirstMessage
        ? [
            // Prompt part 0: system prompt — rendered from the role's systemPromptTemplate
            new SystemMessage(
              renderTemplate(role.systemPromptTemplate, {
                name: role.name,
                description: role.description,
                date: new Date().toISOString().split('T')[0],
              }),
            ),
            // TODO - prompt part 1: inject a separate role prompt (identity, attitude, domain
            //   knowledge, behavioural guidelines distinct from the system prompt) once the
            //   role prompt structure is split from systemPromptTemplate (ADR-013)
            // TODO - prompt part 2: inject company environment message (agent roster, company
            //   name/description, shared storage folder structure) — implement when company
            //   context is wired into the chat path (ADR-001)
            // TODO - prompt part 3: inject services-available message listing MCP server
            //   capabilities and RAG knowledge domains — implement when MCP/RAG integration
            //   lands (ADR-002, ADR-006)
            // TODO - prompt part 5: inject RAG data retrieved for this query — implement when
            //   RAG retrieval is available (ADR-006)
            // TODO - prompt part 6: inject MCP tool responses if the agent pre-fetches data
            //   before its first turn — implement when MCP servers are wired (ADR-002)
            // Prompt part 4: task / query prompt
            new HumanMessage(preparedMessage),
            // TODO - prompt part 8: append a final-instruction suffix message telling the
            //   agent what to do next — implement alongside role prompt restructure (ADR-013)
          ]
        : [new HumanMessage(preparedMessage)];
      // Prompt part 7: conversation history is implicitly provided by the LangGraph
      // checkpoint store keyed on agent.threadId — no explicit injection needed.

      const result = await graph.invoke({ messages }, { ...runConfig, signal });

      const last = result.messages.at(-1);
      const content =
        last instanceof AIMessage && typeof last.content === 'string'
          ? last.content.trim()
          : '';

      await this.saveAudit(agent, role, AuditEventType.LlmResponse, {
        response: content,
      });
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
        await this.saveAudit(agent, role, AuditEventType.StateChange, {
          newStatus: 'idle',
          reason: 'cancelled by user',
        });
        await this.agentRepo.update(agentId, { status: AgentStatus.Idle });
        return { response: '' };
      }

      // err was not a cancellation - move to failed state.
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Chat agent ${agentId} error: ${msg}`);
      await this.saveAudit(agent, role, AuditEventType.StateChange, {
        newStatus: 'failed',
        reason: msg,
      });
      await this.agentRepo.update(agentId, { status: AgentStatus.Failed });
      throw new InternalServerErrorException(
        `Agent encountered an unexpected error.`,
      );
    } finally {
      await checkpointer.end();
    }
  }

  private async saveAudit(
    agent: LcpAgent,
    role: LcpRole,
    eventType: AuditEventType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.auditRepo.save(
      this.auditRepo.create({
        companyId: agent.companyId,
        role: role.name,
        agentId: agent.id,
        eventType,
        payload,
      }),
    );
  }
}

/** Replaces `{{key}}` placeholders in a template string with provided values. */
function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(
    /\{\{(\w+)\}\}/g,
    (_, key: string) => vars[key] ?? '',
  );
}
