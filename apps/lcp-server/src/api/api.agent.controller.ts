import { AgentEvent, AgentStatus, AuditEventType, LcpAgent } from '@lcp/shared';
import {
  BadRequestException,
  Body,
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
  Sse,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { UUID } from 'crypto';
import { defer, from, merge, Observable } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuditService } from '../audit/audit.service';
import { DbService } from '../db/db.service';
import { AgentEventService } from '../events/agent-event.service';
import { AgentOrchestrationService } from './agent-orchestration.service';
import { ChatService } from './chat.service';
import { SendMessageDto, StartAgentDto, StartChatDto } from './dto/agent.dto';

/** REST controller for starting, resuming, chatting with, and inspecting {@link LcpAgent} instances. */
@ApiTags('agents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'api/agent' })
export class AgentController {
  constructor(
    private readonly db: DbService,
    private readonly orchestration: AgentOrchestrationService,
    private readonly chat: ChatService,
    private readonly agentEvents: AgentEventService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Creates a new agent and dispatches it to the lcp-agent worker pool.
   * Returns the agent record immediately; status starts as `idle`.
   */
  @ApiOperation({ summary: 'Start a new agent' })
  @Post('start')
  async startAgent(@Body() body: StartAgentDto): Promise<LcpAgent> {
    return this.orchestration.startAgent(body);
  }

  /**
   * Creates a new chat-mode agent without dispatching to the worker queue.
   * The agent starts in `idle` status and is driven by calls to
   * {@link sendMessage} instead of the BullMQ pipeline.
   */
  @ApiOperation({ summary: 'Start a chat-mode agent' })
  @Post('chat/start')
  async startChat(@Body() body: StartChatDto): Promise<LcpAgent> {
    const agent = await this.db.createAgent({
      companyId: body.companyId,
      roleId: body.roleId,
      initialPrompt: '',
    });
    await this.audit.record(
      agent.companyId,
      body.roleId,
      agent.id,
      AuditEventType.StateChange,
      {
        newStatus: AgentStatus.Idle,
        reason: 'chat session created',
      },
    );
    return agent;
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
  @Post(':id/message')
  @HttpCode(HttpStatus.ACCEPTED)
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
   * SSE stream of turn activity for a chat agent — status transitions, LLM
   * activity, reasoning/response deltas, consultation hand-offs, and the
   * terminal `completed`/`failed` event.
   *
   * On connect, if the agent has already reached a terminal state (the client
   * subscribed after the turn finished), a synthesized terminal event is
   * replayed from the persisted status/output so the client still terminates.
   */
  @ApiOperation({ summary: 'Subscribe to agent events (SSE)' })
  @Sse(':id/events')
  streamEvents(@Param('id') id: UUID): Observable<MessageEvent> {
    const replay$ = defer(() => from(this.replayTerminal(id))).pipe(
      filter((event): event is AgentEvent => event !== null),
    );
    return merge(replay$, this.agentEvents.observe(id)).pipe(
      map((event) => ({ data: event })),
    );
  }

  /**
   * Synthesizes a terminal {@link AgentEvent} for an agent already in a
   * terminal state, or null when it is still running / not found. Used to
   * recover the outcome for clients that subscribe after the turn ended.
   */
  private async replayTerminal(id: UUID): Promise<AgentEvent | null> {
    const agent = await this.db.getAgent(id);
    if (!agent) return null;
    const timestamp = new Date().toISOString();
    if (agent.status === AgentStatus.Completed) {
      return {
        timestamp,
        kind: 'completed',
        data: { response: agent.output ?? '' },
      };
    }
    if (agent.status === AgentStatus.Failed) {
      return {
        timestamp,
        kind: 'failed',
        data: { error: agent.output ?? 'Agent failed' },
      };
    }
    return null;
  }

  /**
   * Dispatches a resume job for an existing agent.
   * The agent must be in `idle`, `paused`, or `failed` status.
   */
  @ApiOperation({ summary: 'Resume a paused or idle agent' })
  @Post('resume/:id')
  async resumeAgent(@Param('id') id: UUID): Promise<LcpAgent> {
    try {
      return await this.orchestration.resumeAgent(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) throw new NotFoundException(msg);
      throw new BadRequestException(msg);
    }
  }

  /** Retrieves the current state of an agent by its UUID. */
  @ApiOperation({ summary: 'Get an agent by ID' })
  @Get(':id')
  async getAgent(@Param('id') id: UUID): Promise<LcpAgent> {
    const agent = await this.db.getAgent(id);
    if (!agent) throw new NotFoundException(`Agent ${id} not found`);
    return agent;
  }

  @ApiOperation({ summary: 'Delete an agent' })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteAgent(@Param('id') id: UUID): Promise<void> {
    const deleted = await this.db.deleteAgent(id);
    if (!deleted) throw new NotFoundException(`Agent ${id} not found`);
    // Complete the SSE subject for this agent so open streams close cleanly
    this.agentEvents.cleanup(id);
  }
}
