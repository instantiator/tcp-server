import {
  AgentStatus,
  AuditEvent,
  AuditEventType,
  TcpAgent,
  WireEvent,
} from '@tcp/shared';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  MessageEvent,
  NotFoundException,
  Param,
  Post,
  Query,
  Sse,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { UUID } from 'crypto';
import { defer, from, merge, Observable } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CompanyMembershipGuard } from '../auth/company-membership.guard';
import {
  CompanyScope,
  CompanyScopeRequired,
} from '../auth/company-scope.decorator';
import { AuditService } from '../audit/audit.service';
import { DbService } from '../db/db.service';
import { AgentEventService } from '../events/agent-event.service';
import {
  AgentOrchestrationService,
  ALL_REASONS,
} from './agent-orchestration.service';
import { AssignmentCompletionService } from './assignment-completion.service';
import { AssignmentService } from './assignment.service';
import { ChatService } from './chat.service';
import { SystemShutdownService } from './system-shutdown.service';
import {
  MessageAcceptedResponseDto,
  SendMessageDto,
  StartAgentDto,
  StartChatDto,
  TranscriptSearchQueryDto,
  TranscriptSearchResponseDto,
} from './dto/agent.dto';
import {
  AgentResponseDto,
  AuditEventResponseDto,
} from './dto/entity-response.dto';

/** REST controller for starting, resuming, chatting with, and inspecting {@link TcpAgent} instances. */
@ApiTags('agents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyMembershipGuard)
@Controller({ path: 'api/agent' })
export class AgentController {
  constructor(
    private readonly db: DbService,
    private readonly orchestration: AgentOrchestrationService,
    private readonly chat: ChatService,
    private readonly agentEvents: AgentEventService,
    private readonly audit: AuditService,
    private readonly shutdown: SystemShutdownService,
    private readonly assignments: AssignmentService,
    private readonly completion: AssignmentCompletionService,
  ) {}

  /**
   * Creates a new agent and dispatches it to the tcp-agent worker pool.
   * Returns the agent record immediately; status starts as `idle`.
   *
   * Refused with `503` while the system is draining for shutdown.
   */
  @ApiOperation({ summary: 'Start a new agent' })
  @ApiCreatedResponse({ type: AgentResponseDto })
  @CompanyScope({ from: 'body', key: 'companyId', via: 'company' })
  @Post('start')
  async startAgent(@Body() body: StartAgentDto): Promise<TcpAgent> {
    this.shutdown.assertAccepting();
    return this.orchestration.startAgent(body);
  }

  /**
   * Creates a new chat-mode agent without dispatching to the worker queue.
   * The agent starts in `idle` status and is driven by calls to
   * {@link sendMessage} instead of the BullMQ pipeline.
   *
   * Goes through {@link AgentOrchestrationService.createAgent} (not
   * `db.createAgent` directly), so its `state_change` — with `entity:'agent'`
   * and a summary — is published the same way every other agent creation is
   * (002.02 stage 2). A separate record here would duplicate that event.
   *
   * Refused with `503` while the system is draining for shutdown.
   */
  @ApiOperation({ summary: 'Start a chat-mode agent' })
  @ApiCreatedResponse({ type: AgentResponseDto })
  @CompanyScope({ from: 'body', key: 'companyId', via: 'company' })
  @Post('chat/start')
  async startChat(@Body() body: StartChatDto): Promise<TcpAgent> {
    this.shutdown.assertAccepting();
    return this.orchestration.createAgent({
      companyId: body.companyId,
      roleId: body.roleId,
      initialPrompt: '',
      mode: 'chat',
    });
  }

  /**
   * Accepts a message for a chat agent and returns `202 Accepted` immediately.
   * The turn runs detached; its reasoning, response, and completion are
   * delivered on the `GET /api/agent/:id/events` SSE stream. Clients should
   * open that stream before (or right after) posting, then watch for the
   * `completed` (or `failed`) event.
   */
  @ApiOperation({
    summary: 'Send a message to a chat agent (accepted; watch SSE)',
  })
  @CompanyScope({ from: 'param', key: 'id', via: 'agent' })
  @Post(':id/message')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({ type: MessageAcceptedResponseDto })
  async sendMessage(
    @Param('id') id: UUID,
    @Body() body: SendMessageDto,
  ): Promise<{ accepted: true }> {
    if (!body.message) {
      throw new BadRequestException('message is required');
    }
    try {
      await this.chat.sendMessage(id, body.message);
      return { accepted: true };
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      throw new InternalServerErrorException('Unexpected error during chat');
    }
  }

  /**
   * Ends the chat this agent is holding, because the person having it says it
   * is over: the assignment moves to `succeeded` and the agent to `completed`.
   *
   * Synchronous, unlike {@link sendMessage} — nothing is dispatched and no turn
   * runs, so the completed agent is returned rather than a `202`. Refused with
   * `409` while a turn is in flight.
   */
  @ApiOperation({ summary: 'Complete a chat' })
  @ApiCreatedResponse({ type: AgentResponseDto })
  @CompanyScope({ from: 'param', key: 'id', via: 'agent' })
  @Post(':id/complete')
  async completeChat(@Param('id') id: UUID): Promise<TcpAgent> {
    // No try/catch, unlike `resumeAgent`: everything below throws Nest
    // exceptions already (404 for an unknown agent, 400 for a non-chat, 409
    // for a race), and wrapping them would turn each into a 500.
    const { assignment } = await this.assignments.getAgentAssignment(id);
    await this.completion.completeChat(assignment);

    // Re-read rather than patch the copy above: the status and output the
    // client needs were written by the completion service, not here.
    const agent = await this.db.getAgent(id);
    if (!agent) throw new NotFoundException(`Agent ${id} not found`);
    return agent;
  }

  /**
   * Deletes a chat: the agent, its assignment and its transcript. Refused
   * with `409` while a turn is in flight, and `400` for a non-chat.
   */
  @ApiOperation({ summary: 'Delete a chat' })
  @ApiNoContentResponse()
  @CompanyScope({ from: 'param', key: 'id', via: 'agent' })
  @Delete(':id/chat')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteChat(@Param('id') id: UUID): Promise<void> {
    const { assignment } = await this.assignments.getAgentAssignment(id);
    await this.completion.deleteChat(assignment);
    this.agentEvents.cleanup(id);
  }

  /**
   * SSE stream of turn activity for a chat agent — status transitions, LLM
   * activity, reasoning/response deltas, consultation hand-offs, and the
   * terminal `completed`/`failed` event.
   *
   * On connect, if the agent has already reached a terminal state (the client
   * subscribed after the turn finished), a synthesized terminal event is
   * replayed from the persisted status/output so the client still terminates.
   */
  @ApiOperation({ summary: 'Subscribe to agent events (SSE)' })
  @CompanyScope({ from: 'param', key: 'id', via: 'agent' })
  @Sse(':id/events')
  streamEvents(@Param('id') id: UUID): Observable<MessageEvent> {
    const replay$ = defer(() => from(this.replayTerminal(id))).pipe(
      filter((event): event is WireEvent => event !== null),
    );
    return merge(replay$, this.agentEvents.observe(id)).pipe(
      map((event) => ({ data: event })),
    );
  }

  /**
   * Synthesizes a terminal `state_change` {@link WireEvent} for an agent
   * already in a terminal state, or null when it is still running / not found.
   * Lets a client that subscribed after the turn ended still recover the
   * outcome and terminate (`reason:'replay'`, no persisted row).
   */
  private async replayTerminal(id: UUID): Promise<WireEvent | null> {
    const agent = await this.db.getAgent(id);
    if (!agent) return null;
    const terminal: AgentStatus[] = [
      AgentStatus.Completed,
      AgentStatus.Failed,
      AgentStatus.Cancelled,
      AgentStatus.Idle,
    ];
    if (!terminal.includes(agent.status)) return null;
    return {
      type: 'audit',
      event: {
        timestamp: new Date().toISOString(),
        companyId: agent.companyId,
        role: '',
        agentId: id,
        assignmentId: agent.assignmentId ?? null,
        taskId: null,
        eventType: AuditEventType.StateChange,
        payload: {
          entity: 'agent',
          newStatus: agent.status,
          response: agent.output ?? '',
          reason: 'replay',
        },
      },
    };
  }

  /**
   * Dispatches a resume job for an existing agent.
   * The agent must be in `idle`, `paused`, or `failed` status.
   */
  @ApiOperation({ summary: 'Resume a paused or idle agent' })
  @ApiCreatedResponse({ type: AgentResponseDto })
  @CompanyScope({ from: 'param', key: 'id', via: 'agent' })
  @Post('resume/:id')
  async resumeAgent(@Param('id') id: UUID): Promise<TcpAgent> {
    try {
      // A user asked for this one agent, so any pause reason may be lifted —
      // except a paused task, which only the task's own resume lifts (409).
      return await this.orchestration.resumeAgent(id, undefined, {
        lifts: ALL_REASONS,
      });
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) throw new NotFoundException(msg);
      throw new BadRequestException(msg);
    }
  }

  /**
   * Lists agents filtered by company, role, and/or assignment (at least one
   * required), and optionally by status. Defaults to currently active agents
   * (`idle`, `running`, `paused`) when `status` is omitted.
   */
  @ApiOperation({ summary: 'List agents' })
  @ApiOkResponse({ type: AgentResponseDto, isArray: true })
  @CompanyScope(
    { from: 'query', key: 'companyId', via: 'company' },
    { from: 'query', key: 'roleId', via: 'role' },
    { from: 'query', key: 'assignmentId', via: 'assignment' },
  )
  @CompanyScopeRequired(
    'Provide at least one of companyId, roleId, or assignmentId',
  )
  @Get()
  async listAgents(
    @Query('companyId') companyId?: UUID,
    @Query('roleId') roleId?: UUID,
    @Query('assignmentId') assignmentId?: UUID,
    @Query('status') status?: AgentStatus,
  ): Promise<TcpAgent[]> {
    if (!companyId && !roleId && !assignmentId) {
      throw new BadRequestException(
        'Provide at least one of companyId, roleId, or assignmentId',
      );
    }
    return this.db.listAgents({ companyId, roleId, assignmentId, status });
  }

  /**
   * Finds the agents whose transcripts contain the text, case-insensitively.
   * Declared before `:id` routes so `search` is not read as an agent id.
   */
  @ApiOperation({ summary: 'Search agent transcripts' })
  @ApiOkResponse({ type: TranscriptSearchResponseDto })
  @CompanyScope({ from: 'query', key: 'companyId', via: 'company' })
  @CompanyScopeRequired('companyId query parameter is required')
  @Get('search')
  async searchTranscripts(
    @Query() query: TranscriptSearchQueryDto,
  ): Promise<TranscriptSearchResponseDto> {
    return {
      agentIds: await this.audit.searchAgentIds(query.companyId, query.q),
    };
  }

  /** Retrieves the current state of an agent by its UUID. */
  @ApiOperation({ summary: 'Get an agent by ID' })
  @ApiOkResponse({ type: AgentResponseDto })
  @CompanyScope({ from: 'param', key: 'id', via: 'agent' })
  @Get(':id')
  async getAgent(@Param('id') id: UUID): Promise<TcpAgent> {
    const agent = await this.db.getAgent(id);
    if (!agent) throw new NotFoundException(`Agent ${id} not found`);
    return agent;
  }

  /**
   * Retrieves an agent's full audit history, oldest first — every
   * `llm_request`/`llm_response`/`tool_call`/`tool_result`/`decision`/
   * `state_change`/`agent_loop_completion` row recorded for it.
   */
  @ApiOperation({ summary: "Get an agent's audit history" })
  @ApiOkResponse({ type: AuditEventResponseDto, isArray: true })
  @CompanyScope({ from: 'param', key: 'id', via: 'agent' })
  @Get(':id/history')
  async getAgentHistory(@Param('id') id: UUID): Promise<AuditEvent[]> {
    const agent = await this.db.getAgent(id);
    if (!agent) throw new NotFoundException(`Agent ${id} not found`);
    return this.audit.list(agent.companyId, [agent.id]);
  }

  @ApiOperation({ summary: 'Delete an agent' })
  @CompanyScope({ from: 'param', key: 'id', via: 'agent' })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteAgent(@Param('id') id: UUID): Promise<void> {
    const deleted = await this.db.deleteAgent(id);
    if (!deleted) throw new NotFoundException(`Agent ${id} not found`);
    // Complete the SSE subject for this agent so open streams close cleanly
    this.agentEvents.cleanup(id);
  }
}
