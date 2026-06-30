import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { CompanyUser, LcpAgent, LcpRole } from '@lcp/shared';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { UUID } from 'crypto';
import { InternalApiKeyGuard } from '../audit/internal-api-key.guard';
import { PauseAndResumeService } from './pause-and-resume.service';
import {
  CompleteDto,
  PauseDto,
  UpdateStorageChangesDto,
} from './dto/internal.dto';

/**
 * Internal service-to-service endpoints for agent lifecycle management.
 * All routes are protected by {@link InternalApiKeyGuard}.
 *
 * Called by lcp-mcp-interactions (pause/complete/list) and indirectly by
 * lcp-agent when an agent finishes normally without calling `complete_task`.
 */
@ApiTags('internal')
@ApiSecurity('internal-api-key')
@Controller('internal')
@UseGuards(InternalApiKeyGuard)
export class InternalController {
  constructor(
    private readonly pauseResume: PauseAndResumeService,
    @InjectRepository(LcpAgent)
    private readonly agentRepo: Repository<LcpAgent>,
    @InjectRepository(LcpRole)
    private readonly roleRepo: Repository<LcpRole>,
    @InjectRepository(CompanyUser)
    private readonly userRepo: Repository<CompanyUser>,
  ) {}

  /**
   * Returns a minimal view of an agent record for service-to-service queries.
   * Currently exposes `storageChanges` for `complete_task` file validation.
   */
  @ApiOperation({ summary: 'Get agent record (internal)' })
  @Get('agent/:agentId')
  async getAgent(@Param('agentId') agentId: UUID): Promise<Partial<LcpAgent>> {
    const agent = await this.agentRepo.findOneBy({ id: agentId });
    if (!agent) throw new NotFoundException(`Agent ${agentId} not found`);
    return { id: agent.id, storageChanges: agent.storageChanges };
  }

  /**
   * Pauses an agent and records the pending interaction.
   * - `type: 'user_input'` → creates a Conversation and returns its slug.
   * - `type: 'agent_consultation'` → starts a consulting agent and returns the consultation id.
   */
  @ApiOperation({
    summary: 'Pause an agent for user input or consultation (internal)',
  })
  @Post('pause')
  async pause(
    @Body() body: PauseDto,
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
      // ValidateIf guarantees these are present when type === 'agent_consultation'
      body.companyId!,
      body.roleName!,
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
  @ApiOperation({ summary: 'Mark an agent as completed (internal)' })
  @Post('agent/:agentId/complete')
  @HttpCode(204)
  async complete(
    @Param('agentId') agentId: UUID,
    @Body() body: CompleteDto,
  ): Promise<void> {
    await this.pauseResume.completeAgent(agentId, body.output);
  }

  /**
   * Merges a storage change snapshot into the agent's tracked storage state.
   * Called fire-and-forget by lcp-agent after each storage tool result.
   * Returns 204 No Content.
   */
  @ApiOperation({ summary: 'Update agent storage changes (internal)' })
  @Patch('agent/:agentId/storage')
  @HttpCode(204)
  async updateStorage(
    @Param('agentId') agentId: UUID,
    @Body() body: UpdateStorageChangesDto,
  ): Promise<void> {
    await this.pauseResume.updateStorageChanges(agentId, body);
  }

  /** Returns all roles belonging to the given company. Used by lcp-mcp-interactions' `list_available_roles`. */
  @ApiOperation({ summary: 'List roles for a company (internal)' })
  @Get('company/:companyId/roles')
  async listRoles(@Param('companyId') companyId: UUID): Promise<LcpRole[]> {
    return this.roleRepo.findBy({ companyId });
  }

  /** Returns all users belonging to the given company. Used by lcp-mcp-interactions' `list_available_users`. */
  @ApiOperation({ summary: 'List users for a company (internal)' })
  @Get('company/:companyId/users')
  async listUsers(@Param('companyId') companyId: UUID): Promise<CompanyUser[]> {
    return this.userRepo.findBy({ companyId });
  }
}
