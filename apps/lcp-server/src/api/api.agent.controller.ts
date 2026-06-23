import { AgentStatus, AuditEvent, AuditEventType, LcpAgent } from '@lcp/shared';
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
  Req,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import type { Request } from 'express';
import { map } from 'rxjs/operators';
import { Repository } from 'typeorm';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DbService } from '../db/db.service';
import { AgentEventService } from '../events/agent-event.service';
import type { LcpAgentTemplate } from '../templates/LcpAgentTemplate';
import { AgentOrchestrationService } from './agent-orchestration.service';
import { ChatMessageResponse, ChatService } from './chat.service';

/** Body for the chat start endpoint. */
interface ChatStartBody {
  companyId: UUID;
  roleId: UUID;
}

/** Body for the send-message endpoint. */
interface SendMessageBody {
  message: string;
}

/** REST controller for starting, resuming, chatting with, and inspecting {@link LcpAgent} instances. */
@UseGuards(JwtAuthGuard)
@Controller({ path: 'api/agent' })
export class AgentController {
  constructor(
    private readonly db: DbService,
    private readonly orchestration: AgentOrchestrationService,
    private readonly chat: ChatService,
    private readonly agentEvents: AgentEventService,
    @InjectRepository(AuditEvent)
    private readonly auditRepo: Repository<AuditEvent>,
  ) {}

  /**
   * Creates a new agent and dispatches it to the lcp-agent worker pool.
   * Returns the agent record immediately; status starts as `idle`.
   */
  @Post('start')
  async startAgent(@Body() body: LcpAgentTemplate): Promise<LcpAgent> {
    if (!body.companyId || !body.roleId || !body.initialPrompt) {
      throw new BadRequestException(
        'companyId, roleId, and initialPrompt are required',
      );
    }
    return this.orchestration.startAgent(body);
  }

  /**
   * Creates a new chat-mode agent without dispatching to the worker queue.
   * The agent starts in `idle` status and is driven by calls to
   * {@link sendMessage} instead of the BullMQ pipeline.
   */
  @Post('chat/start')
  async startChat(@Body() body: ChatStartBody): Promise<LcpAgent> {
    if (!body.companyId || !body.roleId) {
      throw new BadRequestException('companyId and roleId are required');
    }
    const agent = await this.db.createAgent({
      companyId: body.companyId,
      roleId: body.roleId,
      initialPrompt: '',
    });
    await this.auditRepo.save(
      this.auditRepo.create({
        companyId: agent.companyId,
        role: body.roleId,
        agentId: agent.id,
        eventType: AuditEventType.StateChange,
        payload: {
          newStatus: AgentStatus.Idle,
          reason: 'chat session created',
        },
      }),
    );
    return agent;
  }

  /**
   * Sends a single message to a chat agent and returns the agent's response.
   * The HTTP connection is held open for the duration of the LLM call.
   *
   * When the client disconnects before the response arrives, the request socket
   * emits a `close` event which aborts the in-flight LLM call, returning the
   * agent to `idle` status rather than leaving it stuck in `running`.
   */
  @Post(':id/message')
  async sendMessage(
    @Param('id') id: UUID,
    @Body() body: SendMessageBody,
    @Req() req: Request,
  ): Promise<ChatMessageResponse> {
    if (!body.message) {
      throw new BadRequestException('message is required');
    }
    const abort = new AbortController();
    req.socket.on('close', () => abort.abort('client_disconnect'));
    try {
      return await this.chat.sendMessage(id, body.message, abort.signal);
    } catch (err) {
      if (
        err instanceof NotFoundException ||
        err instanceof InternalServerErrorException
      ) {
        throw err;
      }
      throw new InternalServerErrorException('Unexpected error during chat');
    }
  }

  /**
   * SSE stream of processing and compaction events for a chat agent.
   *
   * Clients may connect here after sending a message to receive real-time
   * updates such as `compaction_started` and `compaction_complete` without
   * polling. The stream stays open until the client disconnects.
   */
  @Sse(':id/events')
  streamEvents(@Param('id') id: UUID): import('rxjs').Observable<MessageEvent> {
    return this.agentEvents.observe(id).pipe(map((event) => ({ data: event })));
  }

  /**
   * Dispatches a resume job for an existing agent.
   * The agent must be in `idle`, `paused`, or `failed` status.
   */
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
  @Get(':id')
  async getAgent(@Param('id') id: UUID): Promise<LcpAgent> {
    const agent = await this.db.getAgent(id);
    if (!agent) throw new NotFoundException(`Agent ${id} not found`);
    return agent;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteAgent(@Param('id') id: UUID): Promise<void> {
    const deleted = await this.db.deleteAgent(id);
    if (!deleted) throw new NotFoundException(`Agent ${id} not found`);
    // Complete the SSE subject for this agent so open streams close cleanly
    this.agentEvents.cleanup(id);
  }
}
