import type { Conversation, ConversationMessage } from '@lcp/shared';
import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { UUID } from 'crypto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AgentOrchestrationService } from './agent-orchestration.service';
import { ConversationService } from './conversation.service';
import { ConversationReplyDto } from './dto/conversation.dto';

/** REST controller for agent-to-human conversation queries. */
@ApiTags('conversations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'api/conversation' })
export class ConversationController {
  private readonly logger = new Logger(ConversationController.name);

  constructor(
    private readonly service: ConversationService,
    private readonly orchestration: AgentOrchestrationService,
  ) {}

  /**
   * Lists conversations, optionally filtered by `companyId` and/or `status`.
   * Defaults to returning all statuses when neither filter is provided.
   */
  @ApiOperation({ summary: 'List conversations' })
  @Get()
  async list(
    @Query('companyId') companyId?: UUID,
    @Query('status') status?: string,
  ): Promise<Conversation[]> {
    return this.service.list(companyId, status);
  }

  /** Returns a conversation and its messages identified by slug. */
  @ApiOperation({ summary: 'Get a conversation by slug' })
  @Get(':slug')
  async get(
    @Param('slug') slug: string,
  ): Promise<{ conversation: Conversation; messages: ConversationMessage[] }> {
    return this.service.get(slug);
  }

  /**
   * Posts a user reply to an open conversation, closing it.
   * If the conversation is linked to a paused agent, re-enqueues it with the
   * reply injected as the first message on resume.
   */
  @ApiOperation({ summary: 'Reply to a conversation' })
  @Post(':slug/reply')
  async reply(
    @Param('slug') slug: string,
    @Body() body: ConversationReplyDto,
  ): Promise<Conversation> {
    const conv = await this.service.reply(
      slug,
      body.content,
      body.authorIdentifier,
    );

    if (conv.agentId) {
      // Fire-and-forget — conversation is already closed; don't block on Redis.
      void this.orchestration
        .resumeAgent(conv.agentId, body.content)
        .catch((err: unknown) =>
          this.logger.warn(
            `Could not resume agent ${conv.agentId} after reply to ${slug}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }

    return conv;
  }
}
