import {
  AgentStatus,
  AuditEventType,
  LcpAgent,
  LcpCompany,
  LcpRole,
  buildChatModel,
} from '@lcp/shared';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { END, MessagesAnnotation, StateGraph } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { AuditEvent } from '@lcp/shared';
import { Repository } from 'typeorm';

/** Response returned by {@link ChatService.sendMessage}. */
export interface ChatMessageResponse {
  response: string;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly config: ConfigService,
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
   * @throws {@link NotFoundException} when the agent or its role/LLM config cannot be found
   * @throws {@link InternalServerErrorException} when the LLM call fails
   */
  async sendMessage(
    agentId: string,
    message: string,
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

    const isFirstMessage = agent.threadId === null;
    const messages = isFirstMessage
      ? [
          new SystemMessage(
            renderTemplate(role.systemPromptTemplate, {
              name: role.name,
              description: role.description,
              date: new Date().toISOString().split('T')[0],
            }),
          ),
          new HumanMessage(message),
        ]
      : [new HumanMessage(message)];

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
          messages: [await model.invoke(state.messages)],
        }))
        .addEdge('__start__', 'agent')
        // ponytail: conditional edge to tools node goes here once MCP servers exist
        .addEdge('agent', END)
        .compile({ checkpointer });

      const result = await graph.invoke(
        { messages },
        { configurable: { thread_id: agentId } },
      );

      const last = result.messages.at(-1);
      const content =
        last instanceof AIMessage && typeof last.content === 'string'
          ? last.content.trim()
          : '';

      await this.saveAudit(agent, role, AuditEventType.LlmResponse, {
        response: content,
      });
      await this.agentRepo.update(agentId, { status: AgentStatus.Idle });

      return { response: content };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Chat agent ${agentId} error: ${msg}`);
      await this.saveAudit(agent, role, AuditEventType.StateChange, {
        newStatus: 'failed',
        reason: msg,
      });
      await this.agentRepo.update(agentId, { status: AgentStatus.Failed });
      throw new InternalServerErrorException('Agent encountered an error');
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
