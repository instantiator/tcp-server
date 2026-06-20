import { AgentStatus, AuditEventType, LcpAgent } from '@lcp/shared';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { AuditEvent } from '@lcp/shared';
import { Repository } from 'typeorm';
import { DbService } from '../db/db.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { LcpAgentTemplate } from '../templates/LcpAgentTemplate';
import { AgentOrchestrationService } from './agent-orchestration.service';
import { ChatService, ChatMessageResponse } from './chat.service';

/** Body for the chat start endpoint. */
interface ChatStartBody {
  companyId: string;
  roleId: string;
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
   */
  @Post(':id/message')
  async sendMessage(
    @Param('id') id: string,
    @Body() body: SendMessageBody,
  ): Promise<ChatMessageResponse> {
    if (!body.message) {
      throw new BadRequestException('message is required');
    }
    try {
      return await this.chat.sendMessage(id, body.message);
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
   * Dispatches a resume job for an existing agent.
   * The agent must be in `idle`, `paused`, or `failed` status.
   */
  @Post('resume/:id')
  async resumeAgent(@Param('id') id: string): Promise<LcpAgent> {
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
  async getAgent(@Param('id') id: string): Promise<LcpAgent> {
    const agent = await this.db.getAgent(id);
    if (!agent) throw new NotFoundException(`Agent ${id} not found`);
    return agent;
  }

  /**
   * Deletes an agent and all its associated audit events.
   * Used by the CLI to clean up chat sessions on exit.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteAgent(@Param('id') id: string): Promise<void> {
    const deleted = await this.db.deleteAgent(id);
    if (!deleted) throw new NotFoundException(`Agent ${id} not found`);
  }
}
