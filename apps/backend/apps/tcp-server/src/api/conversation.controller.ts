import type { Conversation, ConversationMessage } from '@tcp/shared';
import { AuditEventType, buildEnquiryChangeSummary } from '@tcp/shared';
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
import { AuditService } from '../audit/audit.service';
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
    private readonly audit: AuditService,
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

  /**
   * Returns a conversation and its messages identified by slug, along with
   * the owning company's `timezone` (for client-side display formatting —
   * timestamps themselves are always UTC).
   */
  @ApiOperation({ summary: 'Get a conversation by slug' })
  @Get(':slug')
  async get(@Param('slug') slug: string): Promise<{
    conversation: Conversation;
    messages: ConversationMessage[];
    companyTimezone: string | null;
  }> {
    return this.service.get(slug);
  }

  /**
   * Posts a user reply to an open conversation, closing it, and records the
   * enquiry's `closed` state change on the company stream.
   * If the conversation is linked to a paused agent, re-enqueues it with the
   * reply injected as the first message on resume.
   */
  @ApiOperation({ summary: 'Reply to a conversation' })
  @Post(':slug/reply')
  async reply(
    @Param('slug') slug: string,
    @Body() body: ConversationReplyDto,
  ): Promise<Conversation> {
    // Record the reply and close the conversation.
    const conv = await this.service.reply(
      slug,
      body.content,
      body.authorIdentifier,
    );

    // The enquiry's closing row, company-scoped. `agentId` stays null so the
    // publisher keeps it on the company stream rather than routing it to the
    // agent channel — see {@link PauseAndResumeService.pauseForUserInput},
    // which writes the matching opening row.
    await this.audit.record(
      conv.companyId,
      conv.roleName,
      null,
      AuditEventType.StateChange,
      {
        entity: 'enquiry',
        newStatus: 'closed',
        reason: 'replied',
        summary: buildEnquiryChangeSummary(conv),
      },
    );

    if (conv.agentId) {
      // Ask the orchestrator to resume the agent — it will stay paused if
      // other requests are still outstanding, or aggregate every response
      // since the pause (including this one) if this was the last.
      // Fire-and-forget — conversation is already closed; don't block on Redis.
      void this.orchestration
        .resumeAgent(conv.agentId)
        .catch((err: unknown) =>
          this.logger.warn(
            `Could not resume agent ${conv.agentId} after reply to ${slug}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }

    return conv;
  }
}
