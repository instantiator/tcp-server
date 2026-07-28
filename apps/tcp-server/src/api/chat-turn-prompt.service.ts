import {
  BaseMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import {
  ContextManagerService,
  DEFAULT_RAG_THRESHOLD,
  KnowledgeRetrievalService,
  LlmConfig,
  McpClientService,
  TcpAgent,
  TcpCompany,
  TcpRole,
  buildAssignmentMessage,
  buildChatModel,
  buildRagMessage,
  buildServicesMessage,
  renderSystemPrompt,
  resolveEmbeddingConfig,
  resolveEnvEmbeddingConfig,
  resolveRunConfig,
} from '@tcp/shared';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CHAT_PROMPT_STRINGS, FINAL_INSTRUCTION } from './chat-prompts';

/** Resolved context for one detached chat turn. */
export interface TurnContext {
  agent: TcpAgent;
  role: TcpRole;
  company: TcpCompany | null;
  llmConfig: LlmConfig;
  windowSize: number;
  isFirstMessage: boolean;
  message: string;
}

/** The tool/model facts a turn's prompt has to describe. */
export interface PromptInputs {
  /** The user message after context preparation (may have been compacted). */
  preparedMessage: string;
  model: ReturnType<typeof buildChatModel>;
  mcpTools: Awaited<ReturnType<McpClientService['loadTools']>>;
  mcpServerUrls: Record<string, string>;
}

/**
 * Assembles the numbered prompt parts for a chat turn — the same structure the
 * worker path builds, so a chat agent and a working agent see their context
 * laid out identically.
 *
 * Only the first turn needs the full build; every later turn is just the user's
 * message, because the LangGraph checkpoint already holds the conversation.
 */
@Injectable()
export class ChatTurnPromptService {
  constructor(
    private readonly config: ConfigService,
    private readonly contextManager: ContextManagerService,
    private readonly ragRetrieval: KnowledgeRetrievalService,
  ) {}

  /** Builds the message list to feed into this turn's graph run. */
  async build(ctx: TurnContext, inputs: PromptInputs): Promise<BaseMessage[]> {
    const { agent, role, company, isFirstMessage } = ctx;
    const { preparedMessage } = inputs;

    // Every later turn is just the user's message: the checkpoint already
    // holds the system prompt, role, company, services and RAG from turn 1.
    if (!isFirstMessage) return [new HumanMessage(preparedMessage)];

    const ragMessage = await this.buildRagMessage(ctx, inputs);
    const servicesText = buildServicesMessage(
      [...new Set(inputs.mcpTools.map((t) => t.serverName))],
      inputs.mcpServerUrls,
      CHAT_PROMPT_STRINGS,
    );

    return [
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
      // Prompt part 4: assignment presentation. For a chat agent this is the
      // chat mode prompt (MODE_PROMPTS.chat) followed by the user's message —
      // built via the same shared builder the worker path uses, so the chat
      // agent knows it is in a conversation. materials/expected are empty for
      // the chat orphan assignment.
      new HumanMessage(this.buildAssignmentText(ctx, preparedMessage)),
      // Prompt part 5: RAG data retrieved for this query (omitted when nothing relevant)
      ...(ragMessage ? [ragMessage] : []),
      // Prompt part 6: MCP pre-task responses (none for stub servers; wired here for future use)
      // Prompt part 7: conversation history is implicitly provided by the LangGraph
      // checkpoint store keyed on agent.threadId — no explicit injection needed.
      // Prompt part 8: final instruction — directs the agent to begin after all context is set
      new HumanMessage(FINAL_INSTRUCTION),
    ];
  }

  /**
   * Prompt part 5: knowledge retrieved for this query, size-guarded so a large
   * retrieval cannot swallow the turn's context window. Null when nothing
   * relevant came back.
   */
  private async buildRagMessage(
    ctx: TurnContext,
    inputs: PromptInputs,
  ): Promise<HumanMessage | null> {
    const { agent, role, company, windowSize } = ctx;
    const chunks = await this.ragRetrieval.retrieve(
      role.id,
      role.companyId,
      inputs.preparedMessage,
      resolveEmbeddingConfig(company, resolveEnvEmbeddingConfig(this.config)),
      undefined,
      resolveRunConfig(
        'ragThreshold',
        role,
        company,
        this.config.get<number>('RAG_THRESHOLD'),
        DEFAULT_RAG_THRESHOLD,
      ),
    );
    if (!chunks.length) return null;

    const overflowPath = company?.slug
      ? `${sanitiseSlug(company.slug)}/tasks/${agent.id}/context-overflow`
      : undefined;
    const ragText = await this.contextManager.guardSection(
      buildRagMessage(chunks, CHAT_PROMPT_STRINGS),
      inputs.model,
      windowSize,
      overflowPath,
    );
    return new HumanMessage(ragText);
  }

  /** Prompt part 4: the chat mode prompt followed by the user's message. */
  private buildAssignmentText(
    ctx: TurnContext,
    preparedMessage: string,
  ): string {
    const { agent, company } = ctx;
    const assignment = agent.assignment;
    return buildAssignmentMessage(
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
    );
  }
}

/** Strips characters unsafe for use as a MinIO path component. */
function sanitiseSlug(slug: string): string {
  return slug.replace(/[^a-zA-Z0-9_-]/g, '_');
}
