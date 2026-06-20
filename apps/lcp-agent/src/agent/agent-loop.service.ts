import {
  AgentStatus,
  AuditEventType,
  LcpAgent,
  LcpCompany,
  LcpRole,
  LlmConfig,
} from '@lcp/shared';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { END, MessagesAnnotation, StateGraph } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditEvent } from '@lcp/shared';
import { buildChatModel } from '../llm/llm-factory';
import { AgentRegistryService } from '../registry/agent-registry.service';

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
 * MCP tool access and RAG memory injection are deferred to a later phase.
 */
@Injectable()
export class AgentLoopService {
  private readonly logger = new Logger(AgentLoopService.name);
  private readonly databaseUrl: string;

  constructor(
    private readonly registry: AgentRegistryService,
    private readonly config: ConfigService,
    @InjectRepository(LcpAgent)
    private readonly agentRepo: Repository<LcpAgent>,
    @InjectRepository(LcpRole)
    private readonly roleRepo: Repository<LcpRole>,
    @InjectRepository(LcpCompany)
    private readonly companyRepo: Repository<LcpCompany>,
    @InjectRepository(AuditEvent)
    private readonly auditRepo: Repository<AuditEvent>,
  ) {
    this.databaseUrl = this.config.getOrThrow<string>('DATABASE_URL');
  }

  /**
   * Runs (or resumes) the agent loop for the given agent.
   * Updates the agent's status throughout and writes {@link AuditEvent} rows.
   */
  async run(agentId: string): Promise<void> {
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

    const llmConfig =
      role.llmConfig ??
      (await this.companyRepo.findOneBy({ id: agent.companyId }))?.llmDefault;

    if (!llmConfig) {
      this.logger.error(
        `No LLM config for agent ${agentId}: role has no llmConfig and company has no llmDefault`,
      );
      await this.updateStatus(agent, AgentStatus.Failed);
      return;
    }

    // Set up a timeout-backed abort controller
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
      await this.runLoop(agent, role, llmConfig, checkpointer, abortController);
    } finally {
      clearTimeout(timeoutId);
      await checkpointer.end();
      this.registry.deregister(agentId);
    }
  }

  private async runLoop(
    agent: LcpAgent,
    role: LcpRole,
    llmConfig: LlmConfig,
    checkpointer: PostgresSaver,
    abortController: AbortController,
  ): Promise<void> {
    const model = buildChatModel(llmConfig);
    const graph = this.buildGraph(model, checkpointer);

    const systemPrompt = renderTemplate(role.systemPromptTemplate, {
      name: role.name,
      description: role.description,
      date: new Date().toISOString().split('T')[0],
    });

    const config = {
      configurable: { thread_id: agent.id },
      signal: abortController.signal,
    };
    const initialState = {
      messages: [
        new SystemMessage(systemPrompt),
        new HumanMessage(agent.initialPrompt),
      ],
    };

    try {
      const lastAiMessage = await this.streamAndAudit(
        graph,
        initialState,
        config,
        agent,
        role,
        abortController,
      );

      if (abortController.signal.aborted) {
        const reason = String(abortController.signal.reason ?? 'unknown');
        await this.recordStateChange(agent, role, 'failed', reason);
        await this.updateStatus(agent, AgentStatus.Failed);
        return;
      }

      // Validate that the agent produced non-empty output
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

      await this.updateStatus(agent, AgentStatus.Completed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Agent ${agent.id} loop error: ${msg}`);
      await this.recordStateChange(agent, role, 'failed', msg);
      await this.updateStatus(agent, AgentStatus.Failed);
    }
  }

  private buildGraph(
    model: ReturnType<typeof buildChatModel>,
    checkpointer: PostgresSaver,
  ) {
    const agentNode = async (state: typeof MessagesAnnotation.State) => {
      const response = await model.invoke(state.messages);
      return { messages: [response] };
    };

    return (
      new StateGraph(MessagesAnnotation)
        .addNode('agent', agentNode)
        .addEdge('__start__', 'agent')
        // ponytail: conditional edge to a tools node goes here once MCP servers exist
        .addEdge('agent', END)
        .compile({ checkpointer })
    );
  }

  /** Streams graph events, writes audit rows, and returns the last AI message. */
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
        await this.saveAudit(agent, role, auditType, event.data);
      }

      if (event.event === 'on_chat_model_end') {
        const output = (event.data as { output?: unknown } | undefined)?.output;
        if (output instanceof AIMessage) lastAiMessage = output;
      }
    }

    return lastAiMessage;
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

  private async recordStateChange(
    agent: LcpAgent,
    role: LcpRole,
    newStatus: string,
    reason: string,
  ): Promise<void> {
    await this.saveAudit(agent, role, AuditEventType.StateChange, {
      newStatus,
      reason,
    });
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
