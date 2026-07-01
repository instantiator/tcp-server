import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import Redis from 'ioredis';
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
import { DEFAULT_LLM_TIMEOUT_MS } from '@lcp/shared';
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

    // Guard so the checkpointer connection pool is closed exactly once even
    // when we need to close it early (before waiting on a Redis subscription).
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

      // If a consultation or user-input tool paused the agent mid-turn, the
      // graph has already terminated and the agent is waiting for a resumed
      // BullMQ run to supply the real answer. Release the checkpointer
      // immediately (no further checkpoint reads needed) and hold the HTTP
      // connection open until the resumed run publishes its response.
      //
      // Also handle Completed: the consultation cycle can race to completion
      // while graph.invoke() is still running its final empty LLM turn, so
      // the agent's status may already be Completed by the time we check.
      // waitForAgentCompletion handles both cases — its polling loop finds
      // the output within one interval when the agent is already done.
      const freshAgent = await this.agentRepo.findOneBy({ id: agentId });
      if (
        freshAgent?.status === AgentStatus.Paused ||
        freshAgent?.status === AgentStatus.Completed
      ) {
        await closeCheckpointer();
        return await this.waitForAgentCompletion(agentId, signal);
      }

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
      await closeCheckpointer();
    }
  }

  /**
   * Subscribes to `agent:completed:{agentId}` on Redis and resolves when the
   * agent's resumed BullMQ run publishes its final response. Called after
   * detecting that a consultation or user-input tool paused the agent.
   *
   * Guards against the race where the resumed run completes (and publishes)
   * before the subscription is established by polling the DB at 500 ms
   * intervals after subscribing — if `agent.output` is already populated,
   * the poll delivers the result without waiting for a Redis message that
   * has already been lost.
   *
   * Resolves with an empty string if the agent fails, the caller's signal is
   * aborted, or the built-in timeout fires (LLM_TIMEOUT_MS, default 30 min).
   */
  private async waitForAgentCompletion(
    agentId: UUID,
    signal?: AbortSignal,
  ): Promise<ChatMessageResponse> {
    const redisUrl = this.config.getOrThrow<string>('REDIS_URL');
    // Use || not ?? — docker-compose passes LLM_TIMEOUT_MS as "" when unset,
    // and "" ?? default returns "" (not null/undefined) triggering an instant timeout.
    const timeoutMs =
      this.config.get<number>('LLM_TIMEOUT_MS') || DEFAULT_LLM_TIMEOUT_MS;
    const channel = `agent:completed:${agentId}`;
    const subscriber = new Redis(redisUrl);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      const response = await new Promise<string>((resolve) => {
        // Ensure the promise resolves at most once regardless of how many
        // signals fire (abort, timeout, message) in quick succession.
        let resolved = false;
        const done = (msg: string) => {
          if (!resolved) {
            resolved = true;
            resolve(msg);
          }
        };

        // Without an explicit error handler, ioredis emits 'error' as an
        // uncaught exception which destroys the HTTP socket. Handle it here
        // so connection drops resolve the wait gracefully.
        subscriber.on('error', (err) => {
          this.logger.error(
            `Redis subscriber error for agent ${agentId}: ${String(err)}`,
          );
          done('');
        });

        subscriber.subscribe(channel, (err) => {
          if (err) {
            this.logger.error(
              `Redis subscribe error for agent ${agentId}: ${String(err)}`,
            );
            done('');
            return;
          }

          // Race-condition safety: if the resumed run completed and published
          // before our SUBSCRIBE arrived, the Redis message is gone. Poll the
          // DB at 500 ms intervals until we find a non-null output, the agent
          // fails, or the outer promise resolves via Redis / timeout / signal.
          void (async () => {
            while (!resolved) {
              await new Promise<void>((r) => setTimeout(r, 500));
              if (resolved) return;
              try {
                const a = await this.agentRepo.findOneBy({ id: agentId });
                if (resolved) return;
                if (a?.status === AgentStatus.Completed && a.output != null) {
                  done(a.output);
                  return;
                }
                if (a?.status === AgentStatus.Failed) {
                  done('');
                  return;
                }
              } catch {
                // transient DB error — continue polling
              }
            }
          })();
        });

        subscriber.on('message', (_ch: string, msg: string) => done(msg));

        timeoutId = setTimeout(() => {
          this.logger.warn(
            `Agent ${agentId} consultation wait timed out after ${timeoutMs}ms`,
          );
          done('');
        }, timeoutMs);

        signal?.addEventListener('abort', () => done(''), { once: true });
      });

      return { response };
    } finally {
      clearTimeout(timeoutId);
      await subscriber.quit().catch(() => {});
      await this.agentRepo.update(agentId, { status: AgentStatus.Idle });
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
