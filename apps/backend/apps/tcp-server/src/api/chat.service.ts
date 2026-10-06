import type { BaseMessage } from '@langchain/core/messages';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import {
  AgentStatus,
  AuditEventType,
  buildAgentChangeSummary,
  ContextManagerService,
  DEFAULT_LLM_CONTEXT_WINDOW,
  LlmIdentity,
  TcpAgent,
  TcpAssignment,
  TcpCompany,
  TcpRole,
  SupervisedGraphResult,
  enrichedAuditForEvent,
  mapStreamDeltas,
  resolveEnvLlmConfig,
  resolveLlmConfig,
  runSupervisedGraph,
} from '@tcp/shared';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { UUID } from 'crypto';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { AgentEventService } from '../events/agent-event.service';
import {
  ChatTurnEnvironmentService,
  TurnEnvironment,
} from './chat-turn-environment.service';
import { ChatTurnPromptService, TurnContext } from './chat-turn-prompt.service';
import { claimStatus } from './claim-status';

/**
 * Runs the interactive chat turns behind `POST /api/agent/:id/message`.
 *
 * A turn is detached: {@link sendMessage} validates and returns, and everything
 * the turn produces reaches clients over the `GET /api/agent/:id/events` SSE
 * stream. Prompt assembly lives in {@link ChatTurnPromptService}.
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly contextManager: ContextManagerService,
    private readonly agentEvents: AgentEventService,
    private readonly environment: ChatTurnEnvironmentService,
    private readonly prompts: ChatTurnPromptService,
    private readonly audit: AuditService,
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
      windowSize: Number(llmConfig.contextWindow) || DEFAULT_LLM_CONTEXT_WINDOW,
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
      const env = await this.environment.assemble(ctx, checkpointer);
      const messages = await this.prompts.build(ctx, env);

      // Lifecycle-event audit writes (below) are fired from the synchronous
      // onEvent hook and can't be awaited there — tracked here instead, and
      // flushed before every terminal state_change record, so a slow
      // llm_response write can never be overtaken on the wire by the turn's
      // own completion event (the SSE client stops reading the moment it
      // sees a terminal event, so an out-of-order llm_response is dropped).
      const pendingAuditWrites: Promise<unknown>[] = [];

      const result = await this.streamTurn(
        ctx,
        env,
        messages,
        pendingAuditWrites,
      );
      if (result.failureReason) {
        throw new Error(result.failureReason);
      }
      await this.settleTurn(ctx, result, pendingAuditWrites, closeCheckpointer);
    } catch (err) {
      await this.recordTurnFailure(ctx, err);
    } finally {
      await closeCheckpointer();
    }
  }

  /**
   * Supervises the turn: checks terminal status, context budget, and tool
   * visibility between every tool-loop iteration, instead of letting the
   * graph's tools -> agent edge run unattended to the end. Forwards every
   * LLM/tool/reasoning/response event to observers as it happens and captures
   * the final AI message for persistence.
   */
  private streamTurn(
    ctx: TurnContext,
    env: TurnEnvironment,
    messages: BaseMessage[],
    pendingAuditWrites: Promise<unknown>[],
  ): Promise<SupervisedGraphResult> {
    const { agent, role, windowSize, llmConfig } = ctx;
    const agentId = agent.id;
    const llm: LlmIdentity = {
      provider: llmConfig.provider,
      model: llmConfig.model,
    };
    return runSupervisedGraph({
      agentId,
      agent,
      role,
      model: env.model,
      allTools: env.langchainTools,
      initialGraph: env.graph,
      input: { messages },
      config: env.runConfig,
      contextManager: this.contextManager,
      windowSize,
      abortController: env.abortController,
      llm,
      hooks: {
        buildGraph: env.buildGraph,
        onEvent: (event) => {
          // Persist each lifecycle event (streamed live by the publisher),
          // and publish token deltas directly to the agent channel.
          const audit = enrichedAuditForEvent(event, llm);
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
  }

  /**
   * Applies the turn's ending. A consultation or user-input tool may have
   * paused the agent mid-turn: its resumed BullMQ run — plus
   * {@link PauseAndResumeService} — records the remaining events (including
   * the terminal one), so we stop there. If the consultation cycle raced to
   * Completed while the final LLM turn ran, the terminal state_change is
   * recorded here from the persisted output. Otherwise the turn's response is
   * persisted and the agent returns to idle.
   */
  private async settleTurn(
    ctx: TurnContext,
    result: SupervisedGraphResult,
    pendingAuditWrites: Promise<unknown>[],
    closeCheckpointer: () => Promise<void>,
  ): Promise<void> {
    const agentId = ctx.agent.id;

    if (result.terminalStatus === AgentStatus.Paused) {
      await closeCheckpointer();
      await Promise.all(pendingAuditWrites);
      return;
    }
    if (result.terminalStatus === AgentStatus.Completed) {
      await closeCheckpointer();
      await Promise.all(pendingAuditWrites);
      const freshAgent = await this.agentRepo.findOneBy({ id: agentId });
      await this.recordTerminalState(
        ctx,
        AgentStatus.Completed,
        freshAgent?.output ?? '',
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
    await this.recordTerminalState(ctx, AgentStatus.Idle, content);
  }

  /** Records the state_change that tells SSE clients the turn is over. */
  private async recordTerminalState(
    ctx: TurnContext,
    newStatus: AgentStatus,
    response: string,
  ): Promise<void> {
    await this.audit.record(
      ctx.agent.companyId,
      ctx.role.name,
      ctx.agent.id,
      AuditEventType.StateChange,
      { entity: 'agent', newStatus, reason: 'turn_complete', response },
    );
  }

  /**
   * The turn is detached — a failure is recorded as a terminal state_change
   * rather than rethrown (there is no caller left to catch it), and the chat
   * agent's orphan assignment is failed alongside it.
   *
   * Writes first, publishes after (002.02 stage 2): this used to publish
   * before the agent row was updated, so a client that refetched on the
   * event could still read the pre-failure status.
   */
  private async recordTurnFailure(
    ctx: TurnContext,
    err: unknown,
  ): Promise<void> {
    const { agent, role } = ctx;
    const msg =
      err instanceof Error && err.message.trim()
        ? err.message
        : 'unexpected LLM failure';
    this.logger.error(`Chat agent ${agent.id} error: ${msg}`);
    await this.agentRepo.update(agent.id, { status: AgentStatus.Failed });
    if (agent.assignmentId) {
      await claimStatus(
        this.assignmentRepo,
        agent.assignmentId,
        'in-progress',
        'failed',
        { failureReason: msg },
      );
    }
    await this.audit.record(
      agent.companyId,
      role.name,
      agent.id,
      AuditEventType.StateChange,
      {
        entity: 'agent',
        newStatus: AgentStatus.Failed,
        reason: msg,
        summary: buildAgentChangeSummary({
          ...agent,
          status: AgentStatus.Failed,
        }),
      },
    );
  }
}
