import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { UUID } from 'crypto';
import { InternalApiKeyGuard } from '../audit/internal-api-key.guard';
import { PauseAndResumeService } from './pause-and-resume.service';

interface PauseUserInputBody {
  type: 'user_input';
  agentId: UUID;
  question: string;
  context?: string;
}

interface PauseConsultationBody {
  type: 'agent_consultation';
  agentId: UUID;
  companyId: UUID;
  roleName: string;
  question: string;
  context?: string;
}

type PauseBody = PauseUserInputBody | PauseConsultationBody;

interface CompleteBody {
  output: string;
}

/**
 * Internal service-to-service endpoints for agent lifecycle management.
 * All routes are protected by {@link InternalApiKeyGuard}.
 *
 * Called by lcp-mcp-interactions (pause/complete) and indirectly by lcp-agent
 * when an agent finishes normally without calling `complete_task`.
 */
@Controller('internal')
@UseGuards(InternalApiKeyGuard)
export class InternalController {
  constructor(private readonly pauseResume: PauseAndResumeService) {}

  /**
   * Pauses an agent and records the pending interaction.
   * - `type: 'user_input'` → creates a Conversation and returns its slug.
   * - `type: 'agent_consultation'` → starts a consulting agent and returns the consultation id.
   */
  @Post('pause')
  async pause(
    @Body() body: PauseBody,
  ): Promise<{ slug?: string; consultationId?: string }> {
    if (body.type === 'user_input') {
      const result = await this.pauseResume.pauseForUserInput(
        body.agentId,
        body.question,
        body.context,
      );
      return { slug: result.slug };
    }

    const result = await this.pauseResume.pauseForConsultation(
      body.agentId,
      body.companyId,
      body.roleName,
      body.question,
      body.context,
    );
    return { consultationId: result.consultationId };
  }

  /**
   * Marks an agent as completed with its final output.
   * If the agent was a consultation agent, also resolves the pending
   * consultation and re-enqueues the calling agent.
   * Returns 204 No Content.
   */
  @Post('agent/:agentId/complete')
  @HttpCode(204)
  async complete(
    @Param('agentId') agentId: UUID,
    @Body() body: CompleteBody,
  ): Promise<void> {
    await this.pauseResume.completeAgent(agentId, body.output);
  }
}
