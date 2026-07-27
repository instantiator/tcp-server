import {
  BadRequestException,
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
import {
  buildEnumValidationError,
  CompanyUser,
  InternalApiKeyGuard,
  TcpAgent,
  TcpRole,
} from '@lcp/shared';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { UUID } from 'crypto';
import { DbService } from '../db/db.service';
import { PauseAndResumeService } from './pause-and-resume.service';
import { TaskOrchestrationService } from './task-orchestration.service';
import {
  CompleteDto,
  FailDto,
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
    private readonly taskOrchestration: TaskOrchestrationService,
    private readonly db: DbService,
    @InjectRepository(TcpAgent)
    private readonly agentRepo: Repository<TcpAgent>,
    @InjectRepository(TcpRole)
    private readonly roleRepo: Repository<TcpRole>,
    @InjectRepository(CompanyUser)
    private readonly userRepo: Repository<CompanyUser>,
  ) {}

  /**
   * Returns a minimal view of an agent record for service-to-service queries.
   * Currently exposes `storageChanges` for `complete_task` file validation.
   */
  @ApiOperation({ summary: 'Get agent record (internal)' })
  @Get('agent/:agentId')
  async getAgent(@Param('agentId') agentId: UUID): Promise<Partial<TcpAgent>> {
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
  ): Promise<{ slug?: string; consultationId?: string; roleName?: string }> {
    if (body.type === 'user_input') {
      const result = await this.pauseResume.pauseForUserInput(
        body.agentId,
        body.question,
        body.context,
        body.userIds,
      );
      return { slug: result.slug };
    }

    // Consulting agents may address the company/role by slug instead of
    // UUID (see docs/prompts/009.2) — resolve whichever was given.
    const companyIdentifier = body.companyId ?? body.companySlug;
    if (!companyIdentifier) {
      throw new BadRequestException(
        'agent_consultation requires companyId or companySlug',
      );
    }
    const company = await this.db.getCompany(companyIdentifier);
    if (!company) {
      throw new NotFoundException(`Company ${companyIdentifier} not found`);
    }

    const roleIdentifier = body.roleId ?? body.roleSlug;
    if (!roleIdentifier) {
      throw new BadRequestException(
        'agent_consultation requires roleId or roleSlug',
      );
    }
    const role = await this.db.findRoleByIdOrSlug(company.id, roleIdentifier);
    if (!role) {
      // Name the roles the caller could consult, so it can retry with a real
      // one rather than guessing (mirrors the create_plan role validation).
      const validRoleSlugs = (await this.db.listRoles(company.id)).map(
        (r) => r.slug,
      );
      throw new NotFoundException(
        buildEnumValidationError('consult that role', [
          {
            property: 'role',
            value: roleIdentifier,
            validValues: validRoleSlugs,
          },
        ]),
      );
    }

    const result = await this.pauseResume.pauseForConsultation(
      body.agentId,
      company.id,
      role.id,
      body.question,
      body.context,
      body.roleName,
    );
    return { consultationId: result.consultationId, roleName: result.roleName };
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
    // Belt-and-braces: fail the task if a planner reached Completed without
    // producing a plan (a no-op for every other completion).
    await this.taskOrchestration.handleAgentCompleted(agentId);
  }

  /**
   * Marks an agent run as failed with the given reason.
   * If the agent was a consultation agent, resolves the pending consultation
   * as `failed` and re-enqueues the calling agent so it can react to the
   * failure instead of waiting forever.
   * Returns 204 No Content.
   */
  @ApiOperation({ summary: 'Mark an agent run as failed (internal)' })
  @Post('agent/:agentId/fail')
  @HttpCode(204)
  async fail(
    @Param('agentId') agentId: UUID,
    @Body() body: FailDto,
  ): Promise<void> {
    await this.pauseResume.failAgent(agentId, body.reason);
    // Propagate the failure to the agent's task, when it has one (orphan/chat
    // agents are unaffected).
    await this.taskOrchestration.handleAgentFailed(agentId, body.reason);
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

  /** Returns all roles belonging to the given company. Used by lcp-mcp-interactions' `list_available_contacts`. */
  @ApiOperation({ summary: 'List roles for a company (internal)' })
  @Get('company/:companyId/roles')
  async listRoles(@Param('companyId') companyId: UUID): Promise<TcpRole[]> {
    return this.roleRepo.findBy({ companyId });
  }

  /** Returns all users belonging to the given company. Used by lcp-mcp-interactions' `list_available_contacts`. */
  @ApiOperation({ summary: 'List users for a company (internal)' })
  @Get('company/:companyId/users')
  async listUsers(@Param('companyId') companyId: UUID): Promise<CompanyUser[]> {
    return this.userRepo.findBy({ companyId });
  }
}
