import type { Conversation, ConversationMessage } from '@lcp/shared';
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { UUID } from 'crypto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ConversationService } from './conversation.service';

interface ReplyBody {
  content: string;
  authorIdentifier?: string;
}

/** REST controller for agent-to-human conversation queries. */
@UseGuards(JwtAuthGuard)
@Controller({ path: 'api/conversation' })
export class ConversationController {
  constructor(private readonly service: ConversationService) {}

  /**
   * Lists conversations, optionally filtered by `companyId` and/or `status`.
   * Defaults to returning all statuses when neither filter is provided.
   */
  @Get()
  async list(
    @Query('companyId') companyId?: UUID,
    @Query('status') status?: string,
  ): Promise<Conversation[]> {
    return this.service.list(companyId, status);
  }

  /** Returns a conversation and its messages identified by slug. */
  @Get(':slug')
  async get(
    @Param('slug') slug: string,
  ): Promise<{ conversation: Conversation; messages: ConversationMessage[] }> {
    return this.service.get(slug);
  }

  /**
   * Posts a user reply to an open conversation, closing it.
   * The agent resume flow is wired in Phase 6 (PauseAndResumeService).
   */
  @Post(':slug/reply')
  async reply(
    @Param('slug') slug: string,
    @Body() body: ReplyBody,
  ): Promise<Conversation> {
    return this.service.reply(slug, body.content, body.authorIdentifier);
  }
}
